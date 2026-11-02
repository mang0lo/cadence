import type { Feature } from './types';
import activities from './activities';
import progress from './progress';
import consistency from './consistency';
import maps from './maps';
import health from './health';

/** Order matters: migrations and derive steps run in this order (after core). */
export const features: Feature[] = [activities, progress, consistency, maps, health];
