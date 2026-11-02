import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';

/**
 * Tiny i18n: nested message objects per namespace, English + German.
 *
 *   t('progress.title')                       → namespace "progress", key "title"
 *   t('common.workouts', { count: 3 })        → plural object { one: '{count} workout', other: '{count} workouts' }
 *   t('activities.greeting', { name: 'Ana' }) → 'Hello {name}' interpolation
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
  const plural = useMemo(() => new Intl.PluralRules(locale), [locale]);

  const t = useCallback<TFunction>(
    (key, vars) => {
      const [ns, ...path] = key.split('.');
      const dict = namespaces[ns!];
      let msg = lookup(dict?.[lang], path) ?? lookup(dict?.en, path);
      if (msg && typeof msg === 'object') {
        const count = Number(vars?.count ?? 0);
        const cat = plural.select(count);
        msg = (msg[cat] ?? msg.other ?? msg.one) as string | undefined;
      }
      if (typeof msg !== 'string') return key;
      if (!vars) return msg;
      return msg.replace(/\{(\w+)\}/g, (_, name: string) => (name in vars ? String(vars[name]) : `{${name}}`));
    },
    [lang, namespaces, plural],
  );

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
