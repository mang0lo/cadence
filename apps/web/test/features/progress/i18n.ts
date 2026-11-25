/** Test helper: the t() of I18nProvider for the 'common' and 'progress' namespaces (same lookup, plurals, interpolation). */
import { messages } from '@/features/progress/messages';
import type { Dictionary, Lang, Messages, TFunction } from '@/lib/i18n';
import { commonMessages } from '@/lib/messages';

export function makeT(lang: Lang, locale: string): TFunction {
  const namespaces: Record<string, Dictionary> = { common: commonMessages, progress: messages };
  const plural = new Intl.PluralRules(locale);
  const lookup = (m: Messages | undefined, path: string[]) => {
    let cur: string | Messages | undefined = m;
    for (const p of path) cur = cur && typeof cur !== 'string' ? cur[p] : undefined;
    return cur;
  };
  return (key, vars) => {
    const [ns, ...path] = key.split('.');
    let msg = lookup(namespaces[ns!]?.[lang], path) ?? lookup(namespaces[ns!]?.en, path);
    if (msg && typeof msg === 'object') msg = (msg[plural.select(Number(vars?.count ?? 0))] ?? msg.other) as string;
    if (typeof msg !== 'string') return key;
    return vars ? msg.replace(/\{(\w+)\}/g, (_, n: string) => (n in vars ? String(vars[n]) : `{${n}}`)) : msg;
  };
}
