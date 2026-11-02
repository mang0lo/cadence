import { useCallback, useState } from 'react';

/** localStorage that never throws (private windows, blocked storage, previews). Per-viewer conveniences only. */
export const storage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
  getJSON<T>(key: string, fallback: T): T {
    const raw = storage.get(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  setJSON(key: string, value: unknown): void {
    storage.set(key, JSON.stringify(value));
  },
};

/** useState persisted in localStorage under `cadence.<key>` (e.g. a remembered tab or filter). */
export function useStoredState<T>(key: string, initial: T): [T, (v: T) => void] {
  const fullKey = `cadence.${key}`;
  const [value, setValue] = useState<T>(() => storage.getJSON(fullKey, initial));
  const update = useCallback(
    (v: T) => {
      setValue(v);
      storage.setJSON(fullKey, v);
    },
    [fullKey],
  );
  return [value, update];
}
