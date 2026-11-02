import type { Dictionary } from '@/lib/i18n';
import { overview } from './i18n/overview';
import { shared } from './i18n/shared';
import { sleep } from './i18n/sleep';

/** i18n namespace 'health' → t('health.…'). Always provide en + de. Sections live in ./i18n. */
export const messages: Dictionary = {
  en: { ...shared.en, overview: overview.en, sleep: sleep.en },
  de: { ...shared.de, overview: overview.de, sleep: sleep.de },
};
