import { sportInfo, type WorkoutStreams } from '@cadence/shared';
import { all, get, prepare, tx, type Db } from '../../db/db';
import { maxPlausibleSpeed, movingThreshold } from '../../derive/streams';
import { gunzipJson } from '../../lib/gzip';
import type { DeriveStep } from '../types';
import { derivePending, updatedAtOf } from './common';
import { hrSpeedHistogram, type HrSpeedHistogram, type StreamFilter } from './math';

/** Bump when the computation changes: rows of older versions are recomputed (derive or lazily). */
export const METRICS_VERSION = 1;

const DYNAMICS = {
  stride: { type: 'HKQuantityTypeIdentifierRunningStrideLength', min: 0.3, max: 3 },
  gct: { type: 'HKQuantityTypeIdentifierRunningGroundContactTime', min: 100, max: 500 },
  vo: { type: 'HKQuantityTypeIdentifierRunningVerticalOscillation', min: 0.02, max: 0.25 },
} as const;
type DynamicsKey = keyof typeof DYNAMICS;

interface WorkoutRef {
  id: number;
  athlete_id: number;
  sport: string;
  start_ts: number;
  end_ts: number;
  updated_at: number;
}

export interface WorkoutMetrics {
  stride_m: number | null;
  gct_ms: number | null;
  vo_m: number | null;
  hr_speed: HrSpeedHistogram | null;
}

/** Warm-up seconds ignored by pace-at-HR (heart rate lags behind the pace at the start). */
export const WARMUP_SKIP_S = 300;

export function streamFilter(sport: string): StreamFilter {
  return { skipS: WARMUP_SKIP_S, minSpeed: movingThreshold(sport), maxSpeed: maxPlausibleSpeed(sport) };
}

function dynamicsTypeIds(db: Db): Record<DynamicsKey, number | null> {
  const id = (identifier: string) =>
    get<{ id: number }>(db, 'SELECT id FROM record_types WHERE identifier = ?', [identifier])?.id ?? null;
  return { stride: id(DYNAMICS.stride.type), gct: id(DYNAMICS.gct.type), vo: id(DYNAMICS.vo.type) };
}

const round = (x: number | null, digits: number) =>
  x === null || !Number.isFinite(x) ? null : Math.round(x * 10 ** digits) / 10 ** digits;

/** Compute the cached metrics of one workout (reads its streams and, for runs, the running-dynamics records). */
export function computeWorkoutMetrics(
  db: Db,
  w: WorkoutRef,
  typeIds: Record<DynamicsKey, number | null>,
): WorkoutMetrics {
  const dyn: Record<DynamicsKey, number | null> = { stride: null, gct: null, vo: null };
  if (w.sport === 'run') {
    for (const key of Object.keys(DYNAMICS) as DynamicsKey[]) {
      const typeId = typeIds[key];
      if (typeId === null) continue;
      // clustered primary key (athlete_id, type_id, start_ts): a cheap range scan
      const r = get<{ v: number | null }>(
        db,
        `SELECT AVG(value) AS v FROM records
         WHERE athlete_id = ? AND type_id = ? AND start_ts >= ? AND start_ts <= ? AND value BETWEEN ? AND ?`,
        [w.athlete_id, typeId, w.start_ts, w.end_ts, DYNAMICS[key].min, DYNAMICS[key].max],
      );
      dyn[key] = r?.v ?? null;
    }
  }
  let hist: HrSpeedHistogram | null = null;
  if (sportInfo(w.sport).distance) {
    const blob = get<{ data: Uint8Array }>(db, 'SELECT data FROM workout_streams WHERE workout_id = ?', [w.id])?.data;
    if (blob) {
      try {
        const st = gunzipJson<WorkoutStreams>(blob);
        hist = hrSpeedHistogram(st, streamFilter(w.sport));
      } catch {
        /* corrupt stream blob: leave empty */
      }
    }
  }
  return {
    stride_m: round(dyn.stride, 3),
    gct_ms: round(dyn.gct, 1),
    vo_m: round(dyn.vo, 4),
    hr_speed: hist,
  };
}

function upsertSql(): string {
  return `INSERT INTO progress_workout_metrics
      (workout_id, athlete_id, version, source_updated_at, stride_m, gct_ms, vo_m, hr_speed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (workout_id) DO UPDATE SET athlete_id = excluded.athlete_id, version = excluded.version,
      source_updated_at = excluded.source_updated_at, stride_m = excluded.stride_m, gct_ms = excluded.gct_ms,
      vo_m = excluded.vo_m, hr_speed = excluded.hr_speed`;
}

/**
 * Compute and store metrics for the given workouts. Each batch is computed first and written in a short
 * transaction (the write lock stalls every other writer). A workout changed since it was read (updated_at) is not
 * written: the newer derivation stores its own row. Returns the number of workouts processed.
 */
export function storeWorkoutMetrics(
  db: Db,
  workouts: WorkoutRef[],
  hooks: { check?: () => void; report?: (fraction: number, message?: string) => void } = {},
): number {
  if (!workouts.length) return 0;
  const typeIds = dynamicsTypeIds(db);
  const ins = prepare(db, upsertSql());
  const BATCH = 40;
  for (let i = 0; i < workouts.length; i += BATCH) {
    hooks.check?.();
    const slice = workouts.slice(i, i + BATCH);
    const results = slice.map((w) => computeWorkoutMetrics(db, w, typeIds));
    tx(db, () => {
      const current = updatedAtOf(db, slice.map((w) => w.id));
      slice.forEach((w, k) => {
        if (current.get(w.id) !== w.updated_at) return;
        const m = results[k]!;
        ins.run(
          w.id,
          w.athlete_id,
          METRICS_VERSION,
          w.updated_at,
          m.stride_m,
          m.gct_ms,
          m.vo_m,
          m.hr_speed ? JSON.stringify(m.hr_speed) : null,
        );
      });
    });
    const done = Math.min(workouts.length, i + slice.length);
    hooks.report?.(done / workouts.length, `${done} / ${workouts.length} workouts`);
  }
  return workouts.length;
}

const REF_COLS = 'w.id, w.athlete_id, w.sport, w.start_ts, w.end_ts, w.updated_at';

/** The cached row of workout `w` (alias m) is missing, of an older version or computed from an older derivation. */
const STALE = 'm.workout_id IS NULL OR m.version <> ? OR m.source_updated_at <> w.updated_at';

/**
 * Derive scope: the listed workouts plus every workout whose cached row is stale (missing, e.g. after a cancelled
 * import, of an older version or computed from an older derivation). A full rebuild ('all') recomputes the stale
 * rows only.
 */
export function workoutsToRefresh(db: Db, athleteId: number, ids: number[] | 'all'): WorkoutRef[] {
  return all<WorkoutRef>(
    db,
    `SELECT ${REF_COLS} FROM workouts w LEFT JOIN progress_workout_metrics m ON m.workout_id = w.id
     WHERE w.athlete_id = ? AND (${STALE} OR w.id IN (SELECT value FROM json_each(?)))
     ORDER BY w.start_ts`,
    [athleteId, METRICS_VERSION, JSON.stringify(ids === 'all' ? [] : ids)],
  );
}

/**
 * Request-time safety net for visible workouts with a stale row (e.g. renamed since, or a database imported before
 * this feature existed). Nothing is computed while an import or rederive job of the athlete is queued or running:
 * its derive steps fill the rows, and computing them here as well would wait for the job's write lock on the
 * server's main thread and could store values of workouts that are not derived yet.
 */
export function ensureWorkoutMetrics(db: Db, athleteId: number, sport: string | null): number {
  if (derivePending(db, athleteId)) return 0;
  const missing = all<WorkoutRef>(
    db,
    `SELECT ${REF_COLS} FROM workouts w LEFT JOIN progress_workout_metrics m ON m.workout_id = w.id
     WHERE w.athlete_id = ? AND w.hidden = 0 AND w.duplicate_of IS NULL ${sport ? 'AND w.sport = ?' : ''}
       AND (${STALE})
     ORDER BY w.start_ts`,
    sport ? [athleteId, sport, METRICS_VERSION] : [athleteId, METRICS_VERSION],
  );
  return storeWorkoutMetrics(db, missing);
}

/** Athletes with workouts whose row is missing or of an older version (checked when the server starts). */
export function athletesMissingMetrics(db: Db): number[] {
  return all<{ athlete_id: number }>(
    db,
    `SELECT DISTINCT w.athlete_id FROM workouts w LEFT JOIN progress_workout_metrics m ON m.workout_id = w.id
     WHERE m.workout_id IS NULL OR m.version <> ?`,
    [METRICS_VERSION],
  ).map((r) => r.athlete_id);
}

export const workoutMetricsStep: DeriveStep = {
  id: 'progress.workout-metrics',
  label: 'Progress: pace at heart rate & running dynamics',
  weight: 1,
  run(ctx) {
    const todo = workoutsToRefresh(ctx.db, ctx.athleteId, ctx.workoutIds);
    const n = storeWorkoutMetrics(ctx.db, todo, { check: ctx.checkCancelled, report: ctx.report });
    ctx.report(1, n ? `${n} workouts` : undefined);
  },
};
