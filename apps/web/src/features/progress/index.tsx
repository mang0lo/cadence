import { TrendingUp, Medal, Gauge } from 'lucide-react';
import type { FeatureModule } from '../types';
import { messages } from './messages';

/** "progress" feature (web). Routes are children of the app shell; pages are lazy-loaded. */
const feature: FeatureModule = {
  name: 'progress',
  messages,
  routes: [
    { path: 'progress', lazy: () => import('./pages/ProgressPage').then((m) => ({ Component: m.default })) },
    { path: 'progress/records', lazy: () => import('./pages/RecordsPage').then((m) => ({ Component: m.default })) },
    { path: 'progress/fitness', lazy: () => import('./pages/FitnessPage').then((m) => ({ Component: m.default })) },
  ],
  nav: [
    { path: '/progress', labelKey: 'progress.nav.progress', icon: TrendingUp, group: 'training', order: 20 },
    { path: '/progress/records', labelKey: 'progress.nav.records', icon: Medal, group: 'training', order: 30 },
    { path: '/progress/fitness', labelKey: 'progress.nav.fitness', icon: Gauge, group: 'training', order: 40 },
  ],
};

export default feature;
