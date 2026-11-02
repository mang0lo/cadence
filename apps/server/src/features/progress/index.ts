import type { Feature } from '../types';
import progressRoutes from './routes';
import { progressMigrations } from './schema';
import { workoutMetricsStep } from './workout-metrics';

/**
 * "progress" feature module (server side) — improvement over time.
 * - migrations: progress_workout_metrics (per-workout cache for pace at heart rate, decoupling, running dynamics)
 * - routes: /api/progress/* (overview, volume, yoy, compare, snapshot, trends, pace-at-hr, intensity, records,
 *   records/history, predictions, fitness, physiology, preferences)
 * - deriveSteps: progress.workout-metrics (fills the cache for new/changed workouts)
 */
const feature: Feature = {
  name: 'progress',
  migrations: progressMigrations,
  deriveSteps: [workoutMetricsStep],
  routes: progressRoutes,
};

export default feature;
