import type { ComponentType } from 'react';
import type { RouteObject } from 'react-router';
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

type WidgetComponents = Map<string, ComponentType>;

let loaded: WidgetComponents | undefined;
let loading: Promise<WidgetComponents> | undefined;

/**
 * Loads the code of every feature's dashboard widgets (FeatureModule.widgets, in their features' widgets chunks) once.
 * After a failure the next call tries again.
 */
export function loadWidgets(): Promise<WidgetComponents> {
  loading ??= Promise.all(dashboardWidgets.map(async (w) => [w.id, await w.component()] as const)).then(
    (entries) => (loaded = new Map(entries)),
    (e: unknown) => {
      loading = undefined;
      throw e;
    },
  );
  return loading;
}

/** The widget components once loadWidgets() has finished, so the dashboard renders them without suspending. */
export const loadedWidgets = (): WidgetComponents | undefined => loaded;

/**
 * The dashboard is the index route. Its lazy() loads the page and the widgets in parallel and waits for both, so the
 * dashboard shows up complete, after one round trip on a first visit. A failed load fails the route, and App.tsx shows
 * ChunkError, which offers a reload.
 */
export function withDashboardWidgets(route: RouteObject): RouteObject {
  const lazy = route.lazy;
  if (!route.index || typeof lazy !== 'function') return route;
  return { ...route, lazy: () => Promise.all([lazy(), loadWidgets()]).then(([r]) => r) } as RouteObject;
}
