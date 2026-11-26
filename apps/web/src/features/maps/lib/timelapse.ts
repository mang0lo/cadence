import { useCallback, useSyncExternalStore } from 'react';

/**
 * Minimal observable value, for the heatmap time-lapse position that changes every animation frame: the map follows it
 * imperatively (useOverlayStore) and the caption and scrubber re-render throttled, so the page does not re-render 60
 * times a second. Same pattern as the activity replay (features/activities/lib/store.ts).
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
    for (const l of [...this.listeners]) l(v);
  }
  subscribe(fn: (v: T) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

/**
 * The store's value for text that follows it: re-renders at most every `ms` milliseconds while the value changes (the
 * last change always arrives); a render for any other reason reads the current value.
 */
export function useThrottledStore<T>(store: Store<T>, ms = 100): T {
  const subscribe = useCallback(
    (onChange: () => void) => {
      let last = -Infinity;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const fire = () => {
        clearTimeout(timer);
        timer = undefined;
        last = performance.now();
        onChange();
      };
      const unsubscribe = store.subscribe(() => {
        const wait = last + ms - performance.now();
        if (wait <= 0) fire();
        else timer ??= setTimeout(fire, wait);
      });
      return () => {
        unsubscribe();
        clearTimeout(timer);
      };
    },
    [store, ms],
  );
  return useSyncExternalStore(subscribe, () => store.get());
}
