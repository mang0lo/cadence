import type { Dictionary } from '@/lib/i18n';
import { body } from './i18n/body';
import { ecg } from './i18n/ecg';
import { explorer, metric } from './i18n/explorer';
import { heart } from './i18n/heart';
import { overview, widget } from './i18n/overview';
import { readiness } from './i18n/readiness';
import { shared } from './i18n/shared';
import { sleep } from './i18n/sleep';

/** i18n namespace 'health' → t('health.…'). Always provide en + de. Sections live in ./i18n. */
export const messages: Dictionary = {
  en: { ...shared.en, overview: overview.en, sleep: sleep.en, heart: heart.en, body: body.en, explorer: explorer.en, metric: metric.en, ecg: ecg.en, widget: widget.en, readiness: readiness.en },
  de: { ...shared.de, overview: overview.de, sleep: sleep.de, heart: heart.de, body: body.de, explorer: explorer.de, metric: metric.de, ecg: ecg.de, widget: widget.de, readiness: readiness.de },
};
