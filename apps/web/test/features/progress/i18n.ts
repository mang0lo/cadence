/** Test helper: the t() of I18nProvider for the 'common' and 'progress' namespaces. */
import { messages } from '@/features/progress/messages';
import { createT, type Lang, type TFunction } from '@/lib/i18n';
import { commonMessages } from '@/lib/messages';

export function makeT(lang: Lang, locale: string): TFunction {
  return createT(lang, locale, { common: commonMessages, progress: messages });
}
