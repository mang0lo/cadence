import { run } from '../../db/db';
import type { Feature } from '../types';
import { geometryStep } from './geometry';
import { migrations } from './migrations';
import { routesStep } from './route-derive';
import { segmentsStep } from './segments';
import { mapsRoutes } from './routes';

/**
 * "maps" feature module (server side).
 * - migrations: ids start with 'maps_'
 * - routes: mounted under /api/maps
 * - deriveSteps: ids start with 'maps.', run in the import worker after core derivation
 */
const feature: Feature = {
  name: 'maps',
  migrations,
  deriveSteps: [geometryStep, routesStep, segmentsStep],
  routes: mapsRoutes,
  // segments are user-made and carry their own geometry: keep them when all data is deleted (their efforts go
  // with the workouts and are matched again by maps.segments after the next import)
  keepOnReset: ['maps_segments'],
  onReset: (db, athleteId) =>
    run(db, 'UPDATE maps_segments SET source_workout_id = NULL WHERE athlete_id = ?', [athleteId]),
};

export default feature;
