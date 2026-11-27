import { all, type Db } from '../db/db';
import type { DeriveStep } from '../features/types';
import { asCore } from './context';
import { dailyActivityStep, dailyMetricsStep } from './daily';
import { duplicatesStep } from './duplicates';
import { effortStep } from './effort';
import { workoutsStep } from './workouts';

function duplicateMarks(db: Db, athleteId: number): Map<number, number> {
  return new Map(
    all<{ id: number; duplicate_of: number }>(
      db,
      'SELECT id, duplicate_of FROM workouts WHERE athlete_id = ? AND duplicate_of IS NOT NULL',
      [athleteId],
    ).map((r) => [r.id, r.duplicate_of]),
  );
}

/**
 * Duplicate detection of the scoped workouts can (un)mark overlapping workouts outside the scope: those are
 * reported in ctx.changes.duplicateFlips (workoutIds keeps meaning "workouts whose inputs changed").
 */
const duplicatesWithFlips: DeriveStep = {
  ...duplicatesStep,
  async run(ctx) {
    if (ctx.workoutIds === 'all' || !ctx.workoutIds.length) return duplicatesStep.run(ctx);
    const before = duplicateMarks(ctx.db, ctx.athleteId);
    await duplicatesStep.run(ctx);
    const after = duplicateMarks(ctx.db, ctx.athleteId);
    const scoped = new Set(ctx.workoutIds);
    const flips = new Set<number>();
    for (const [id, primary] of before) if (after.get(id) !== primary && !scoped.has(id)) flips.add(id);
    for (const id of after.keys()) if (!before.has(id) && !scoped.has(id)) flips.add(id);
    if (flips.size) asCore(ctx).changes.duplicateFlips.push(...[...flips].sort((a, b) => a - b));
  },
};

/**
 * Core derive steps, in order:
 *  1. core.workouts       – streams (GPS + HR + cadence + power), moving time, speeds, elevation, splits,
 *                           best efforts, polyline, HR histogram
 *  2. core.duplicates     – duplicate_of for overlapping copies from other sources
 *  3. core.daily-metrics  – daily_metrics + record_type_stats (needed for the observed resting HR)
 *  4. core.effort         – effective HR (once, after max HRs are known) → HR zones + relative effort
 *  5. core.daily-activity – daily_activity totals
 * Feature steps run afterwards (see derive/run.ts).
 */
export const coreDeriveSteps: DeriveStep[] = [
  workoutsStep,
  duplicatesWithFlips,
  dailyMetricsStep,
  effortStep,
  dailyActivityStep,
];
