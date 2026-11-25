import type { Feature } from '../types';
import { reconcileCorosRings } from './coros-health';
import { connectMigrations } from './migrations';
import { connectRoutes } from './routes';

/**
 * "connect" feature module (server side): activities from other watches, pulled from the vendor cloud.
 * - COROS: the private Training Hub API (unofficial), see coros-client.ts.
 * - migrations: ids start with 'connect_'; routes under /api/connect.
 * - deriveSteps: connect.coros shows COROS' or Apple's rings per Settings → My watch.
 * Downloaded FIT files are imported by the regular import job (src/import/fit).
 */
const feature: Feature = {
  name: 'connect',
  migrations: connectMigrations,
  routes: connectRoutes,
  deriveSteps: [
    {
      id: 'connect.coros',
      label: 'COROS daily data',
      weight: 0.1,
      run(ctx) {
        reconcileCorosRings(ctx.db, ctx.athleteId);
        ctx.report(1);
      },
    },
  ],
  // the COROS login (email, password hash, tokens): reconnect on the Watches page after restoring a backup
  secretSettings: ['connect.coros'],
};

export default feature;
