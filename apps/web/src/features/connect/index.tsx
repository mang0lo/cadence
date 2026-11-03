import { Watch } from 'lucide-react';
import type { FeatureModule } from '../types';
import { messages } from './messages';

/** Activities from other watches (COROS cloud sync, FIT files). */
const feature: FeatureModule = {
  name: 'connect',
  messages,
  routes: [{ path: 'connect', lazy: () => import('./ConnectPage').then((m) => ({ Component: m.default })) }],
  nav: [{ path: '/connect', labelKey: 'connect.nav.title', icon: Watch, group: 'app', order: 5 }],
};

export default feature;
