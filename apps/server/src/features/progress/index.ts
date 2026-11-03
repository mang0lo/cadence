import type { Feature } from '../types';
import { powerCurveStep } from './power-curve';
import progressRoutes from './routes';
import { progressMigrations } from './schema';
import { workoutMetricsStep } from './workout-metrics';

/**
 * "progress" feature module (server side) — improvement over time.
 * - migrations: progress_workout_metrics (per-workout cache for pace at heart rate, decoupling, running dynamics),
 *   progress_power_bests + progress_power_state (best average power per duration and workout)
 * - routes: /api/progress/* (overview, volume, yoy, compare, snapshot, trends, pace-at-hr, intensity, records,
 *   records/history, predictions, fitness, physiology, power/curve, power/ftp, preferences)
 * - deriveSteps: progress.workout-metrics, progress.power-curve (fill the caches for new/changed workouts)
 */
const feature: Feature = {
  name: 'progress',
  migrations: progressMigrations,
  deriveSteps: [workoutMetricsStep, powerCurveStep],
  routes: progressRoutes,
};

export default feature;
