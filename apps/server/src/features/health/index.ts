import type { Feature } from '../types';
import { healthMigrations } from './migrations';
import { ecgStep } from './ecg-routes';
import healthRoutes from './routes';
import { sleepStep } from './sleep';

/**
 * "health" feature module (server side).
 * - migrations: ids start with 'health_'
 * - routes: mounted under /api/health (see routes.ts)
 * - deriveSteps: run in the import worker after core derivation (ids start with 'health.')
 */
const feature: Feature = {
  name: 'health',
  migrations: healthMigrations,
  deriveSteps: [sleepStep, ecgStep],
  routes: healthRoutes,
};

export default feature;
