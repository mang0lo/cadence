import type { Feature } from '../types';

/**
 * "maps" feature module (server side).
 * - migrations: ids must start with 'maps_'
 * - routes: mounted under /api/maps
 * - deriveSteps: run in the import worker after core derivation
 */
const feature: Feature = {
  name: 'maps',
  migrations: [],
  deriveSteps: [],
  routes: async () => {},
};

export default feature;
