import { lazy } from 'react';
import { LayoutDashboard, ListChecks } from 'lucide-react';
import type { FeatureModule } from '../types';
import { messages } from './messages';

/** "activities" feature (web). Routes are children of the app shell; pages are lazy-loaded. */
const feature: FeatureModule = {
  name: 'activities',
  messages,
  routes: [
    // the dashboard: App.tsx loads the features' widgets in parallel with this page (withDashboardWidgets)
    { index: true, lazy: () => import('./pages/HomePage').then((m) => ({ Component: m.default })) },
    { path: 'activities', lazy: () => import('./pages/ActivitiesPage').then((m) => ({ Component: m.default })) },
    { path: 'activities/:id', lazy: () => import('./pages/ActivityPage').then((m) => ({ Component: m.default })) },
    {
      path: 'activities/:id/compare/:otherId',
      lazy: () => import('./pages/ComparePage').then((m) => ({ Component: m.default })),
    },
  ],
  nav: [
    { path: '/', labelKey: 'activities.nav.dashboard', icon: LayoutDashboard, group: 'training', order: 0, end: true },
    { path: '/activities', labelKey: 'activities.nav.activities', icon: ListChecks, group: 'training', order: 10 },
  ],
  whatsNew: lazy(() => import('./components/WhatsNewRecords')),
};

export default feature;
