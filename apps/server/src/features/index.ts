import type { Feature } from './types';
import activities from './activities';
import progress from './progress';
import consistency from './consistency';
import maps from './maps';
import health from './health';
import connect from './connect';

/**
 * Order matters: migrations and derive steps run in this order (after core). connect before consistency: its
 * connect.coros step settles COROS' or Apple's rings (Settings → My watch) that consistency.achievements reads.
 * Migrations are applied by id, so a database migrated in an earlier order needs nothing again.
 */
export const features: Feature[] = [activities, progress, connect, consistency, maps, health];
