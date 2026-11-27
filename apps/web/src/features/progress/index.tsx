import { TrendingUp, Medal, Gauge, Zap } from 'lucide-react';
import type { FeatureModule } from '../types';
import { messages } from './messages';

const widgets = () => import('./widgets');

/** "progress" feature (web). Routes are children of the app shell; pages and dashboard widgets are lazy-loaded. */
const feature: FeatureModule = {
  name: 'progress',
  messages,
  routes: [
    { path: 'progress', lazy: () => import('./pages/ProgressPage').then((m) => ({ Component: m.default })) },
    { path: 'progress/records', lazy: () => import('./pages/RecordsPage').then((m) => ({ Component: m.default })) },
    { path: 'progress/power', lazy: () => import('./pages/PowerPage').then((m) => ({ Component: m.default })) },
    { path: 'progress/fitness', lazy: () => import('./pages/FitnessPage').then((m) => ({ Component: m.default })) },
  ],
  nav: [
    { path: '/progress', labelKey: 'progress.nav.progress', icon: TrendingUp, group: 'training', order: 20 },
    { path: '/progress/records', labelKey: 'progress.nav.records', icon: Medal, group: 'training', order: 30 },
    { path: '/progress/power', labelKey: 'progress.nav.power', icon: Zap, group: 'training', order: 35 },
    { path: '/progress/fitness', labelKey: 'progress.nav.fitness', icon: Gauge, group: 'training', order: 40 },
  ],
  widgets: [
    { id: 'weekly-snapshot', order: 10, component: () => widgets().then((m) => m.WeeklySnapshotWidget) },
    { id: 'fitness', order: 30, component: () => widgets().then((m) => m.FitnessWidget) },
    { id: 'power', order: 40, component: () => widgets().then((m) => m.PowerWidget) },
  ],
};

export default feature;
