import { useEffect, useSyncExternalStore } from 'react';
import type { ThemePref } from '@cadence/shared';
import { storage } from './storage';

export type ResolvedTheme = 'light' | 'dark';

const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function currentTheme(): ResolvedTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

const listeners = new Set<() => void>();
const observer =
  typeof MutationObserver !== 'undefined'
    ? new MutationObserver(() => listeners.forEach((l) => l()))
    : null;
observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

/** The theme actually applied to the page right now (re-renders on change). Charts and maps use this. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    currentTheme,
    () => 'light',
  );
}

/** Applies a theme preference to <html data-theme> and follows the OS when 'system'. */
export function useApplyTheme(pref: ThemePref): void {
  useEffect(() => {
    storage.set('cadence.theme', pref);
    const apply = () => {
      const dark = pref === 'dark' || (pref === 'system' && !!media?.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    if (pref !== 'system' || !media) return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [pref]);
}

/** Read a CSS custom property from :root (e.g. cssVar('--series-1')). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
