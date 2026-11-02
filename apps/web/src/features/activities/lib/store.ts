import { useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Minimal observable value. Used for state that changes every animation frame (playback time, hover position)
 * so that maps and chart overlays can update imperatively without re-rendering React trees.
 */
export class Store<T> {
  private listeners = new Set<(v: T) => void>();
  constructor(private value: T) {}
  get(): T {
    return this.value;
  }
  set(v: T): void {
    if (Object.is(v, this.value)) return;
    this.value = v;
    for (const l of this.listeners) l(v);
  }
  subscribe(fn: (v: T) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Re-render on every change (for rarely changing values). */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.get(),
    () => store.get(),
  );
}

/** Re-render at most every `ms` milliseconds (for per-frame values shown as text). */
export function useThrottledStore<T>(store: Store<T>, ms = 100): T {
  const [v, setV] = useState(store.get());
  useEffect(() => {
    let last = 0;
    let timer: number | null = null;
    const unsub = store.subscribe((x) => {
      const now = performance.now();
      if (now - last >= ms) {
        last = now;
        setV(x);
      } else if (timer === null) {
        timer = window.setTimeout(() => {
          timer = null;
          last = performance.now();
          setV(store.get());
        }, ms);
      }
    });
    return () => {
      unsub();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [store, ms]);
  return v;
}
