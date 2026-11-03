import type { Feature } from '../types';
import { connectMigrations } from './migrations';
import { connectRoutes } from './routes';

/**
 * "connect" feature module (server side): activities from other watches, pulled from the vendor cloud.
 * - COROS: the private Training Hub API (unofficial), see coros-client.ts.
 * - migrations: ids start with 'connect_'; routes under /api/connect.
 * Downloaded FIT files are imported by the regular import job (src/import/fit).
 */
const feature: Feature = {
  name: 'connect',
  migrations: connectMigrations,
  routes: connectRoutes,
};

export default feature;
