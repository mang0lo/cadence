import { useCallback, useSyncExternalStore } from 'react';

/** Whether a CSS media query matches, updated when it changes (e.g. `'(min-width: 64rem)'` = Tailwind's `lg`). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', notify);
      return () => m.removeEventListener('change', notify);
    },
    [query],
  );
  const get = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, get, () => false);
}
