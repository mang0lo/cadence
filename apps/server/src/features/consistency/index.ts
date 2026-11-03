import type { Feature } from '../types';
import { migrations } from './migrations';
import routes from './routes';
import { achievementsStep } from './trophies';
import { consistencyWhatsNew } from './whats-new';

/**
 * "consistency" feature module (server side): calendar, streaks, consistency score, goals, trophies and
 * year in review.
 * - migrations: consistency_goals (user goals), consistency_achievements (derived trophies)
 * - routes: mounted under /api/consistency
 * - deriveSteps: consistency.achievements (trophy evaluation after every import / rebuild)
 */
const feature: Feature = {
  name: 'consistency',
  migrations,
  deriveSteps: [achievementsStep],
  routes,
  // goals are user-written: keep them when the user deletes all imported data
  keepOnReset: ['consistency_goals'],
  whatsNew: consistencyWhatsNew,
};

export default feature;
