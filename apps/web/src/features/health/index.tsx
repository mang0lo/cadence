import { HeartPulse, Moon, Heart, Scale, Database, Activity, BatteryCharging } from 'lucide-react';
import type { FeatureModule } from '../types';
import { hasBodyData } from '@/lib/sources';
import { messages } from './messages';

/** "health" feature (web). Routes are children of the app shell; pages are lazy-loaded. */
const feature: FeatureModule = {
  name: 'health',
  messages,
  routes: [
    { path: 'health', lazy: () => import('./pages/HealthPage').then((m) => ({ Component: m.default })) },
    { path: 'health/readiness', lazy: () => import('./pages/ReadinessPage').then((m) => ({ Component: m.default })) },
    { path: 'health/sleep', lazy: () => import('./pages/SleepPage').then((m) => ({ Component: m.default })) },
    { path: 'health/heart', lazy: () => import('./pages/HeartPage').then((m) => ({ Component: m.default })) },
    { path: 'health/body', lazy: () => import('./pages/BodyPage').then((m) => ({ Component: m.default })) },
    { path: 'health/explorer', lazy: () => import('./pages/ExplorerPage').then((m) => ({ Component: m.default })) },
    { path: 'health/explorer/:type', lazy: () => import('./pages/MetricPage').then((m) => ({ Component: m.default })) },
    { path: 'health/ecg', lazy: () => import('./pages/EcgPage').then((m) => ({ Component: m.default })) },
  ],
  nav: [
    { path: '/health', labelKey: 'health.nav.overview', icon: HeartPulse, group: 'health', order: 0, end: true },
    { path: '/health/readiness', labelKey: 'health.nav.readiness', icon: BatteryCharging, group: 'health', order: 5 },
    { path: '/health/sleep', labelKey: 'health.nav.sleep', icon: Moon, group: 'health', order: 10 },
    { path: '/health/heart', labelKey: 'health.nav.heart', icon: Heart, group: 'health', order: 20 },
    { path: '/health/body', labelKey: 'health.nav.body', icon: Scale, group: 'health', order: 30, available: hasBodyData },
    { path: '/health/explorer', labelKey: 'health.nav.explorer', icon: Database, group: 'health', order: 40 },
    {
      path: '/health/ecg',
      labelKey: 'health.nav.ecg',
      icon: Activity,
      group: 'health',
      order: 50,
      available: (s) => s.ecgCount > 0,
    },
  ],
};

export default feature;
