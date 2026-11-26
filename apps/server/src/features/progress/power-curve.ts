import { PROGRESS_POWER_DURATIONS, type WorkoutStreams } from '@cadence/shared';
import { all, get, prepare, tx, type Db } from '../../db/db';
import { gunzipJson } from '../../lib/gzip';
import { localDay } from '../../lib/time';
import type { DeriveStep } from '../types';
import { derivePending, updatedAtOf } from './common';
import { bestAverages, powerParts, type BestAverage } from './power-math';

/** Bump when the computation changes: rows of older versions are recomputed (derive or lazily). */
export const POWER_CURVE_VERSION = 1;

export interface PowerWorkoutRef {
  id: number;
  athlete_id: number;
  sport: string;
  start_ts: number;
  tz_min: number;
  updated_at: number;
  /**
   * avg_power ?? max_power. The core sets avg_power from the power stream whenever there is one, so workouts where
   * both are null have no power and are stored without decoding their streams.
   */
  power: number | null;
}

export interface WorkoutPowerBests {
  bests: BestAverage[];
  /** Seconds of the workout that carry power. */
  seconds: number;
}

const NONE: WorkoutPowerBests = { bests: [], seconds: 0 };

/** Best average power per standard duration of one workout (reads its streams). */
export function computePowerBests(db: Db, w: Pick<PowerWorkoutRef, 'id' | 'power'>): WorkoutPowerBests {
  if (w.power === null) return NONE;
  const blob = get<{ data: Uint8Array }>(db, 'SELECT data FROM workout_streams WHERE workout_id = ?', [
    w.id,
  ])?.data;
  if (!blob) return NONE;
  let st: WorkoutStreams;
  try {
    st = gunzipJson<WorkoutStreams>(blob);
  } catch {
    return NONE; // corrupt stream blob
  }
  if (!st.power) return NONE;
  const parts = powerParts(st);
  const bests = bestAverages(parts, PROGRESS_POWER_DURATIONS);
  return bests.length ? { bests, seconds: parts.reduce((s, p) => s + p.measured, 0) } : NONE;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Compute and store the bests of the given workouts (also hidden ones and duplicates: the queries exclude those, so
 * hiding or un-hiding needs no recomputation). Computation happens outside the short write transactions. A workout
 * changed since it was read (updated_at) is not written: the newer derivation stores its own rows.
 * Returns the number of workouts processed.
 */
export function storePowerBests(
  db: Db,
  workouts: PowerWorkoutRef[],
  hooks: { check?: () => void; report?: (fraction: number, message?: string) => void } = {},
): number {
  if (!workouts.length) return 0;
  const del = prepare(db, 'DELETE FROM progress_power_bests WHERE workout_id = ?');
  const ins = prepare(
    db,
    `INSERT INTO progress_power_bests (workout_id, athlete_id, sport, day, duration_s, watts, offset_s)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const state = prepare(
    db,
    `INSERT INTO progress_power_state (workout_id, athlete_id, version, source_updated_at, power_s)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (workout_id) DO UPDATE SET athlete_id = excluded.athlete_id, version = excluded.version,
       source_updated_at = excluded.source_updated_at, power_s = excluded.power_s`,
  );
  const BATCH = 40;
  for (let i = 0; i < workouts.length; i += BATCH) {
    hooks.check?.();
    const slice = workouts.slice(i, i + BATCH);
    const results = slice.map((w) => computePowerBests(db, w));
    tx(db, () => {
      const current = updatedAtOf(db, slice.map((w) => w.id));
      slice.forEach((w, k) => {
        if (current.get(w.id) !== w.updated_at) return;
        const r = results[k]!;
        del.run(w.id);
        const day = localDay(w.start_ts, w.tz_min);
        for (const b of r.bests)
          ins.run(w.id, w.athlete_id, w.sport, day, b.durationS, r1(b.watts), r1(b.offsetS));
        state.run(w.id, w.athlete_id, POWER_CURVE_VERSION, w.updated_at, Math.round(r.seconds));
      });
    });
    const done = Math.min(workouts.length, i + slice.length);
    hooks.report?.(done / workouts.length, `${done} / ${workouts.length} workouts`);
  }
  return workouts.length;
}

const REF_COLS =
  'w.id, w.athlete_id, w.sport, w.start_ts, w.tz_min, w.updated_at, COALESCE(w.avg_power, w.max_power) AS power';

/** The state row of workout `w` (alias s) is missing, of an older version or computed from an older derivation. */
const STALE = 's.workout_id IS NULL OR s.version <> ? OR s.source_updated_at <> w.updated_at';

/**
 * Derive scope: the listed workouts plus every workout whose state row is stale (missing, e.g. after a cancelled
 * import, of an older version or computed from an older derivation). A full rebuild ('all') recomputes the stale
 * rows only.
 */
export function powerWorkoutsToRefresh(db: Db, athleteId: number, ids: number[] | 'all'): PowerWorkoutRef[] {
  return all<PowerWorkoutRef>(
    db,
    `SELECT ${REF_COLS} FROM workouts w LEFT JOIN progress_power_state s ON s.workout_id = w.id
     WHERE w.athlete_id = ? AND (${STALE} OR w.id IN (SELECT value FROM json_each(?)))
     ORDER BY w.start_ts`,
    [athleteId, POWER_CURVE_VERSION, JSON.stringify(ids === 'all' ? [] : ids)],
  );
}

/**
 * Request-time safety net for visible workouts with a stale state row (e.g. a database imported before the power
 * curve existed). Nothing is computed while an import or rederive job of the athlete is queued or running: its
 * derive steps fill the rows (see ensureWorkoutMetrics).
 */
export function ensurePowerBests(db: Db, athleteId: number): number {
  if (derivePending(db, athleteId)) return 0;
  const missing = all<PowerWorkoutRef>(
    db,
    `SELECT ${REF_COLS} FROM workouts w LEFT JOIN progress_power_state s ON s.workout_id = w.id
     WHERE w.athlete_id = ? AND w.hidden = 0 AND w.duplicate_of IS NULL AND (${STALE})
     ORDER BY w.start_ts`,
    [athleteId, POWER_CURVE_VERSION],
  );
  return storePowerBests(db, missing);
}

/** Athletes with workouts whose state row is missing or of an older version (checked when the server starts). */
export function athletesMissingPowerBests(db: Db): number[] {
  return all<{ athlete_id: number }>(
    db,
    `SELECT DISTINCT w.athlete_id FROM workouts w LEFT JOIN progress_power_state s ON s.workout_id = w.id
     WHERE s.workout_id IS NULL OR s.version <> ?`,
    [POWER_CURVE_VERSION],
  ).map((r) => r.athlete_id);
}

export const powerCurveStep: DeriveStep = {
  id: 'progress.power-curve',
  label: 'Progress: power curve',
  weight: 1,
  run(ctx) {
    const todo = powerWorkoutsToRefresh(ctx.db, ctx.athleteId, ctx.workoutIds);
    const n = storePowerBests(ctx.db, todo, { check: ctx.checkCancelled, report: ctx.report });
    ctx.report(1, n ? `${n} workouts` : undefined);
  },
};
