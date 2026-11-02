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
};

export default feature;
