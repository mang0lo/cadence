import type { Feature } from '../types';

/**
 * "progress" feature module (server side).
 * - migrations: ids must start with 'progress_'
 * - routes: mounted under /api/progress
 * - deriveSteps: run in the import worker after core derivation
 */
const feature: Feature = {
  name: 'progress',
  migrations: [],
  deriveSteps: [],
  routes: async () => {},
};

export default feature;
