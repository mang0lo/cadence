import type { Feature } from '../types';
import { workoutCachesStep } from './derive';
import progressRoutes from './routes';
import { progressMigrations } from './schema';

/**
 * "progress" feature module (server side) — improvement over time.
 * - migrations: progress_workout_metrics (per-workout cache for pace at heart rate and running dynamics),
 *   progress_power_bests + progress_power_state (best average power per duration and workout)
 * - routes: /api/progress/* (overview, volume, yoy, compare, snapshot, trends, pace-at-hr, intensity, records,
 *   records/history, predictions, fitness, physiology, power/curve, power/ftp, preferences)
 * - deriveSteps: progress.workout-caches (fills both caches for new/changed/stale workouts in one pass)
 */
const feature: Feature = {
  name: 'progress',
  migrations: progressMigrations,
  deriveSteps: [workoutCachesStep],
  routes: progressRoutes,
};

export default feature;
