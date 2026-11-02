import { Settings, Upload } from 'lucide-react';
import type { FeatureModule } from '../types';
import { messages } from './messages';

/** Import, settings, login — the app's own plumbing. */
const feature: FeatureModule = {
  name: 'platform',
  messages,
  routes: [
    { path: 'import', lazy: () => import('./ImportPage').then((m) => ({ Component: m.default })) },
    { path: 'settings', lazy: () => import('./SettingsPage').then((m) => ({ Component: m.default })) },
  ],
  nav: [
    { path: '/import', labelKey: 'platform.nav.import', icon: Upload, group: 'app', order: 0 },
    { path: '/settings', labelKey: 'platform.nav.settings', icon: Settings, group: 'app', order: 10 },
  ],
};

export default feature;
