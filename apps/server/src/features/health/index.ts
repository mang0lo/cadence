import type { Feature } from '../types';

/**
 * "health" feature module (server side).
 * - migrations: ids must start with 'health_'
 * - routes: mounted under /api/health
 * - deriveSteps: run in the import worker after core derivation
 */
const feature: Feature = {
  name: 'health',
  migrations: [],
  deriveSteps: [],
  routes: async () => {},
};

export default feature;
