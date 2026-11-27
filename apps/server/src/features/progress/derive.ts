import { tx } from '../../db/db';
import type { DeriveStep } from '../types';
import { workoutStreams } from './common';
import {
  computePowerBests,
  powerReadsStreams,
  powerWorkoutsToRefresh,
  writePowerBests,
  type PowerWorkoutRef,
  type WorkoutPowerBests,
} from './power-curve';
import {
  computeWorkoutMetrics,
  dynamicsTypeIds,
  metricsReadStreams,
  workoutsToRefresh,
  writeWorkoutMetrics,
  type WorkoutMetrics,
  type WorkoutRef,
} from './workout-metrics';

/**
 * Derive step of both per-workout caches: pace at heart rate & running dynamics (progress_workout_metrics) and the
 * power curve (progress_power_bests + progress_power_state). Each cache keeps its own version and staleness check
 * (workoutsToRefresh / powerWorkoutsToRefresh); one pass over the workouts either cache needs decodes each stream
 * once. Every batch is computed first and written in one short transaction.
 */
export const workoutCachesStep: DeriveStep = {
  id: 'progress.workout-caches',
  label: 'Progress: pace at heart rate, running dynamics & power curve',
  weight: 2,
  run(ctx) {
    const { db, athleteId } = ctx;
    const metrics = new Map(workoutsToRefresh(db, athleteId, ctx.workoutIds).map((w) => [w.id, w]));
    const power = new Map(powerWorkoutsToRefresh(db, athleteId, ctx.workoutIds).map((w) => [w.id, w]));
    const startOf = (id: number) => (metrics.get(id) ?? power.get(id))!.start_ts;
    const ids = [...new Set([...metrics.keys(), ...power.keys()])].sort((a, b) => startOf(a) - startOf(b) || a - b);
    const typeIds = dynamicsTypeIds(db);
    const BATCH = 40;
    for (let i = 0; i < ids.length; i += BATCH) {
      ctx.checkCancelled();
      const m: { w: WorkoutRef; m: WorkoutMetrics }[] = [];
      const p: { w: PowerWorkoutRef; r: WorkoutPowerBests }[] = [];
      for (const id of ids.slice(i, i + BATCH)) {
        const mw = metrics.get(id);
        const pw = power.get(id);
        const streams = (mw && metricsReadStreams(mw)) || (pw && powerReadsStreams(pw)) ? workoutStreams(db, id) : null;
        if (mw) m.push({ w: mw, m: computeWorkoutMetrics(db, mw, typeIds, streams) });
        if (pw) p.push({ w: pw, r: computePowerBests(db, pw, streams) });
      }
      tx(db, () => {
        writeWorkoutMetrics(db, m);
        writePowerBests(db, p);
      });
      const done = Math.min(ids.length, i + BATCH);
      ctx.report(done / ids.length, `${done} / ${ids.length} workouts`);
    }
    ctx.report(1, ids.length ? `${ids.length} workouts` : undefined);
  },
};
