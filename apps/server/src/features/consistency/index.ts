import type { Feature } from '../types';

/**
 * "consistency" feature module (server side).
 * - migrations: ids must start with 'consistency_'
 * - routes: mounted under /api/consistency
 * - deriveSteps: run in the import worker after core derivation
 */
const feature: Feature = {
  name: 'consistency',
  migrations: [],
  deriveSteps: [],
  routes: async () => {},
};

export default feature;
