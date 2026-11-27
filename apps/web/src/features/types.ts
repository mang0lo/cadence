import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { RouteObject } from 'react-router';
import type { DataSourcesInfo, ImportHighlight } from '@cadence/shared';
import type { Dictionary } from '@/lib/i18n';

export type NavGroup = 'training' | 'habits' | 'explore' | 'health' | 'app';

export interface NavItem {
  /** Absolute path, e.g. '/progress'. */
  path: string;
  /** i18n key, e.g. 'progress.nav.overview'. */
  labelKey: string;
  icon: LucideIcon;
  group: NavGroup;
  /** Sort order inside the group (lower first). */
  order: number;
  /** Match only the exact path (for '/' style routes). */
  end?: boolean;
  /** Shown only when this returns true for the athlete's data (e.g. ECG only with ECG recordings). */
  available?: (sources: DataSourcesInfo) => boolean;
}

/**
 * A web feature module. Routes are children of the app shell (no leading slash, e.g. 'progress' or
 * 'progress/records'). Use `lazy` so heavy pages (maps/charts) are code-split.
 * `messages` is registered as the i18n namespace `name` → t('<name>.key').
 */
export interface FeatureModule {
  name: string;
  routes: RouteObject[];
  nav: NavItem[];
  messages: Dictionary;
  /**
   * Renders this feature's highlights in the summary after an import ("what's new": records, trophies …), i.e. the
   * ImportHighlights whose `feature` is this module's name. Use React.lazy: it is only needed on the import screen.
   */
  whatsNew?: ComponentType<WhatsNewProps>;
  /** This feature's dashboard widgets; the dashboard shows the widgets of all features sorted by `order`. */
  widgets?: DashboardWidget[];
}

/**
 * A widget in the dashboard's side column. It renders its own <Card> (or null when there is nothing to show) and
 * fetches its own data; the dashboard wraps it in an error boundary.
 */
export interface DashboardWidget {
  /** Unique across features, e.g. 'streak'. */
  id: string;
  /** Position in the column, across all features (lower first). */
  order: number;
  /**
   * Loads the component by a dynamic import of the feature's widgets.tsx, e.g.
   * `() => import('./widgets').then((m) => m.StreakWidget)`, so its code stays out of the entry chunk. The dashboard
   * page loads all widgets before it shows up.
   */
  component: () => Promise<ComponentType>;
  /** Shown only when this returns true for the athlete's data (like NavItem.available). */
  available?: (sources: DataSourcesInfo) => boolean;
}

export interface WhatsNewProps {
  items: ImportHighlight[];
}
