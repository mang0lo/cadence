import { Flame, Grid3x3, Route, Waypoints } from 'lucide-react';
import type { FeatureModule } from '../types';
import { messages } from './messages';

/** "maps" feature (web). Routes are children of the app shell; pages are lazy-loaded. */
const feature: FeatureModule = {
  name: 'maps',
  messages,
  routes: [
    {
      path: 'maps/heatmap',
      lazy: () => import('./pages/HeatmapPage').then((m) => ({ Component: m.default })),
    },
    {
      path: 'maps/explorer',
      lazy: () => import('./pages/ExplorerPage').then((m) => ({ Component: m.default })),
    },
    { path: 'maps/routes', lazy: () => import('./pages/RoutesPage').then((m) => ({ Component: m.default })) },
    {
      path: 'maps/routes/:id',
      lazy: () => import('./pages/RoutePage').then((m) => ({ Component: m.default })),
    },
    {
      path: 'maps/segments',
      lazy: () => import('./pages/SegmentsPage').then((m) => ({ Component: m.default })),
    },
    {
      path: 'maps/segments/new',
      lazy: () => import('./pages/SegmentNewPage').then((m) => ({ Component: m.default })),
    },
    {
      path: 'maps/segments/:id',
      lazy: () => import('./pages/SegmentPage').then((m) => ({ Component: m.default })),
    },
  ],
  nav: [
    { path: '/maps/heatmap', labelKey: 'maps.nav.heatmap', icon: Flame, group: 'explore', order: 0 },
    { path: '/maps/explorer', labelKey: 'maps.nav.explorer', icon: Grid3x3, group: 'explore', order: 10 },
    { path: '/maps/routes', labelKey: 'maps.nav.routes', icon: Route, group: 'explore', order: 20 },
    { path: '/maps/segments', labelKey: 'maps.nav.segments', icon: Waypoints, group: 'explore', order: 30 },
  ],
};

export default feature;
