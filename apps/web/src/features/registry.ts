import type { Dictionary } from '@/lib/i18n';
import { commonMessages } from '@/lib/messages';
import type { FeatureModule } from './types';
import activities from './activities';
import progress from './progress';
import consistency from './consistency';
import maps from './maps';
import health from './health';
import platform from './platform';

export const featureModules: FeatureModule[] = [activities, progress, consistency, maps, health, platform];

/** i18n namespaces: 'common' + one per feature. */
export const namespaces: Record<string, Dictionary> = {
  common: commonMessages,
  ...Object.fromEntries(featureModules.map((f) => [f.name, f.messages])),
};
