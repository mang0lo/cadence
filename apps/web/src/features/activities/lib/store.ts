import { useCallback, useSyncExternalStore } from 'react';

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
  // stable callbacks: a new subscribe function on every render would make React unsubscribe and subscribe again
  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
  const get = useCallback(() => store.get(), [store]);
  return useSyncExternalStore(subscribe, get, get);
}

/**
 * Subscribe to `store`, calling `notify` at most every `ms` milliseconds: right away after a quiet period, else once
 * when the period is over (the last change is never lost). Returns the unsubscribe function.
 */
export function throttledSubscribe<T>(store: Store<T>, ms: number, notify: () => void): () => void {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsub = store.subscribe(() => {
    if (timer !== null) return;
    const now = performance.now();
    if (now - last >= ms) {
      last = now;
      notify();
    } else {
      timer = setTimeout(() => {
        timer = null;
        last = performance.now();
        notify();
      }, ms - (now - last));
    }
  });
  return () => {
    unsub();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

/**
 * Re-render at most every `ms` milliseconds (for per-frame values shown as text). Always shows the value of the
 * store passed now: a new store (e.g. a new Playback after a time-base switch) is read right away, not after its
 * first change.
 */
export function useThrottledStore<T>(store: Store<T>, ms = 100): T {
  const subscribe = useCallback((notify: () => void) => throttledSubscribe(store, ms, notify), [store, ms]);
  const get = useCallback(() => store.get(), [store]);
  return useSyncExternalStore(subscribe, get, get);
}
