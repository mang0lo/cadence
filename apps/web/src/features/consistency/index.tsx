import { lazy } from 'react';
import { CalendarCheck, Target, Trophy, Sparkles } from 'lucide-react';
import type { FeatureModule } from '../types';
import { messages } from './messages';

const yearPage = () => import('./pages/YearInReviewPage').then((m) => ({ Component: m.default }));

/**
 * "consistency" feature (web): consistency calendar & streaks, goals, trophies, year in review.
 * Dashboard widgets (StreakWidget, GoalsWidget, CalendarWidget) live in ./widgets.tsx.
 */
const feature: FeatureModule = {
  name: 'consistency',
  messages,
  routes: [
    { path: 'consistency', lazy: () => import('./pages/ConsistencyPage').then((m) => ({ Component: m.default })) },
    { path: 'goals', lazy: () => import('./pages/GoalsPage').then((m) => ({ Component: m.default })) },
    { path: 'trophies', lazy: () => import('./pages/TrophiesPage').then((m) => ({ Component: m.default })) },
    { path: 'year', lazy: yearPage },
    { path: 'year/:year', lazy: yearPage },
  ],
  nav: [
    { path: '/consistency', labelKey: 'consistency.nav.consistency', icon: CalendarCheck, group: 'habits', order: 0 },
    { path: '/goals', labelKey: 'consistency.nav.goals', icon: Target, group: 'habits', order: 10 },
    { path: '/trophies', labelKey: 'consistency.nav.trophies', icon: Trophy, group: 'habits', order: 20 },
    { path: '/year', labelKey: 'consistency.nav.year', icon: Sparkles, group: 'habits', order: 30 },
  ],
  whatsNew: lazy(() => import('./components/WhatsNewTrophies')),
};

export default feature;
