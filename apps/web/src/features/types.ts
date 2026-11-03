import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { RouteObject } from 'react-router';
import type { ImportHighlight } from '@cadence/shared';
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
}

export interface WhatsNewProps {
  items: ImportHighlight[];
}
