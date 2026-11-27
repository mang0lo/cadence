import type { DataSourcesInfo } from '@cadence/shared';
import type { Dictionary } from '@/lib/i18n';
import { commonMessages } from '@/lib/messages';
import type { DashboardWidget, FeatureModule } from './types';
import activities from './activities';
import progress from './progress';
import consistency from './consistency';
import maps from './maps';
import health from './health';
import connect from './connect';
import platform from './platform';

export const featureModules: FeatureModule[] = [
  activities,
  progress,
  consistency,
  maps,
  health,
  connect,
  platform,
];

/** i18n namespaces: 'common' + one per feature. */
export const namespaces: Record<string, Dictionary> = {
  common: commonMessages,
  ...Object.fromEntries(featureModules.map((f) => [f.name, f.messages])),
};

/** The dashboard widgets of all features, in dashboard order. */
export const dashboardWidgets: DashboardWidget[] = featureModules
  .flatMap((f) => f.widgets ?? [])
  .sort((a, b) => a.order - b.order);

/** The widgets shown for these data sources: all of them while the sources are unknown, so nothing flickers away. */
export const dashboardWidgetsFor = (
  sources: DataSourcesInfo | undefined,
  widgets: DashboardWidget[] = dashboardWidgets,
): DashboardWidget[] => widgets.filter((w) => !w.available || !sources || w.available(sources));
