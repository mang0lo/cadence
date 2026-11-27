import { createContext, useContext, useMemo, type ReactNode } from 'react';

/**
 * Tiny i18n: nested message objects per namespace, English + German.
 *
 *   t('progress.title')                       → namespace "progress", key "title"
 *   t('common.workouts', { count: 3 })        → plural object { one: '{count} workout', other: '{count} workouts' }
 *   t('activities.greeting', { name: 'Ana' }) → 'Hello {name}' interpolation
 *
 * Numbers are written the way the locale writes them ({ count: 1234 } → '1,234' / '1.234', at most 3 decimals),
 * except calendar years: variables named `year`, `prev` or `…Year` print as they are. Strings print unchanged, so a
 * value the caller formatted already (fmt.distance …) stays as it is; a formatted `count` ('1.000') still picks the
 * right plural form.
 *
 * Missing German strings fall back to English, missing English strings to the key itself.
 */
export type Lang = 'en' | 'de';
export interface Messages {
  [key: string]: string | Messages;
}
export interface Dictionary {
  en: Messages;
  de: Messages;
}
export type TFunction = (key: string, vars?: Record<string, string | number>) => string;

interface I18nValue {
  lang: Lang;
  /** BCP-47 locale for Intl (e.g. 'de-AT', 'en-US'). */
  locale: string;
  t: TFunction;
}

const I18nContext = createContext<I18nValue | null>(null);

/** Variables that hold a calendar year: printed without grouping ('2026', never '2,026'). */
const YEAR_VAR = /^(year|prev)$|Year$/;

function lookup(messages: Messages | undefined, path: string[]): string | Messages | undefined {
  let cur: string | Messages | undefined = messages;
  for (const p of path) {
    if (!cur || typeof cur === 'string') return undefined;
    cur = cur[p];
  }
  return cur;
}

export function resolveLang(pref: 'auto' | Lang): Lang {
  if (pref !== 'auto') return pref;
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return nav.toLowerCase().startsWith('de') ? 'de' : 'en';
}

export function resolveLocale(lang: Lang): string {
  const nav = typeof navigator !== 'undefined' ? navigator.language : '';
  if (nav.toLowerCase().startsWith(lang)) return nav;
  return lang === 'de' ? 'de-DE' : 'en-US';
}

/** Reads a number the locale wrote ('1.234,5' in German, '1,234.5' in English); NaN when it is none. */
function numberParser(locale: string): (text: string) => number {
  const parts = new Intl.NumberFormat(locale).formatToParts(-12345.6);
  const part = (type: string, fallback: string) => parts.find((p) => p.type === type)?.value ?? fallback;
  const group = part('group', ',');
  const decimal = part('decimal', '.');
  const minus = part('minusSign', '-');
  return (text) => Number(text.replaceAll(group, '').replace(/\s/g, '').replace(decimal, '.').replace(minus, '-'));
}

/** The t() of I18nProvider for one language (lookup, plurals, interpolation, numbers as the locale writes them). */
export function createT(lang: Lang, locale: string, namespaces: Record<string, Dictionary>): TFunction {
  const plural = new Intl.PluralRules(locale);
  const number = new Intl.NumberFormat(locale);
  const parse = numberParser(locale);
  // no '-0' for a value that rounds to zero
  const formatNumber = (v: number) => number.format(Math.round(Math.abs(v) * 1000) === 0 ? 0 : v);
  return (key, vars) => {
    const [ns, ...path] = key.split('.');
    const dict = namespaces[ns!];
    let msg = lookup(dict?.[lang], path) ?? lookup(dict?.en, path);
    if (msg && typeof msg === 'object') {
      const count = vars?.count ?? 0;
      const cat = plural.select(typeof count === 'string' ? parse(count) : count);
      msg = (msg[cat] ?? msg.other ?? msg.one) as string | undefined;
    }
    if (typeof msg !== 'string') return key;
    if (!vars) return msg;
    return msg.replace(/\{(\w+)\}/g, (_, name: string) => {
      if (!(name in vars)) return `{${name}}`;
      const v = vars[name];
      return typeof v === 'number' && !YEAR_VAR.test(name) ? formatNumber(v) : String(v);
    });
  };
}

export function I18nProvider({
  lang,
  namespaces,
  children,
}: {
  lang: Lang;
  namespaces: Record<string, Dictionary>;
  children: ReactNode;
}) {
  const locale = resolveLocale(lang);
  const t = useMemo(() => createT(lang, locale, namespaces), [lang, locale, namespaces]);
  const value = useMemo(() => ({ lang, locale, t }), [lang, locale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}

/** Shorthand: `const t = useT();` */
export function useT(): TFunction {
  return useI18n().t;
}
