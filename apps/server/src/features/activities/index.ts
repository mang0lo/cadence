import type { Feature } from '../types';

/**
 * "activities" feature module (server side).
 * - migrations: ids must start with 'activities_'
 * - routes: mounted under /api/activities
 * - deriveSteps: run in the import worker after core derivation
 */
const feature: Feature = {
  name: 'activities',
  migrations: [],
  deriveSteps: [],
  routes: async () => {},
};

export default feature;
