import { PROGRESS_POWER_DURATIONS, type WorkoutStreams } from '@cadence/shared';
import { all, get, prepare, tx, type Db } from '../../db/db';
import { gunzipJson } from '../../lib/gzip';
import { localDay } from '../../lib/time';
import type { DeriveStep } from '../types';
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
 * hiding or un-hiding needs no recomputation). Computation happens outside the short write transactions.
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
      slice.forEach((w, k) => {
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

/**
 * Derive scope: the changed workouts, or for a full rebuild every workout whose state row is missing, of an older
 * version or computed from an older derivation (workouts.updated_at changed).
 */
export function powerWorkoutsToRefresh(db: Db, athleteId: number, ids: number[] | 'all'): PowerWorkoutRef[] {
  if (ids === 'all') {
    return all<PowerWorkoutRef>(
      db,
      `SELECT ${REF_COLS} FROM workouts w LEFT JOIN progress_power_state s ON s.workout_id = w.id
       WHERE w.athlete_id = ? AND (s.workout_id IS NULL OR s.version <> ? OR s.source_updated_at <> w.updated_at)
       ORDER BY w.start_ts`,
      [athleteId, POWER_CURVE_VERSION],
    );
  }
  const out: PowerWorkoutRef[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    out.push(
      ...all<PowerWorkoutRef>(
        db,
        `SELECT ${REF_COLS} FROM workouts w WHERE w.athlete_id = ? AND w.id IN (${chunk.map(() => '?').join(',')})`,
        [athleteId, ...chunk],
      ),
    );
  }
  return out;
}

/**
 * Request-time safety net: visible workouts without a (current-version) state row — e.g. a database imported before
 * the power curve existed — are computed on first use. A no-op once the derive step has run.
 */
export function ensurePowerBests(db: Db, athleteId: number): number {
  const missing = all<PowerWorkoutRef>(
    db,
    `SELECT ${REF_COLS} FROM workouts w LEFT JOIN progress_power_state s ON s.workout_id = w.id
     WHERE w.athlete_id = ? AND w.hidden = 0 AND w.duplicate_of IS NULL AND (s.workout_id IS NULL OR s.version <> ?)
     ORDER BY w.start_ts`,
    [athleteId, POWER_CURVE_VERSION],
  );
  return storePowerBests(db, missing);
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
