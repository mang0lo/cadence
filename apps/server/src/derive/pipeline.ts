import type { DeriveStep } from '../features/types';
import { dailyActivityStep, dailyMetricsStep } from './daily';
import { duplicatesStep } from './duplicates';
import { effortStep } from './effort';
import { workoutsStep } from './workouts';

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
  duplicatesStep,
  dailyMetricsStep,
  effortStep,
  dailyActivityStep,
];
