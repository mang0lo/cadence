/**
 * A minimal hook runtime, so hooks can be tested without a DOM (the web tests run in node and render nothing).
 *
 *   vi.mock('react', async () => (await import('./fake-react')).fakeReact);
 *   const h = renderHook((props) => useSomething(props), initialProps);
 *
 * useRef/useState/useMemo/useCallback/useEffect behave like React's for one component: effects run after every render
 * in call order (cleanups first), and a state update re-renders synchronously (after the running render or effect
 * flush). Enough for lifecycle logic; not a React replacement.
 */

type Deps = readonly unknown[] | undefined;
type Cleanup = void | (() => void);

interface Runtime {
  slots: unknown[];
  effects: { deps: Deps; cleanup: Cleanup }[];
  queue: (() => void)[];
  cursor: number;
  effectCursor: number;
  schedule: () => void;
}

let active: Runtime | null = null;

const current = (): Runtime => {
  if (!active) throw new Error('hook called outside renderHook');
  return active;
};

const changed = (a: Deps, b: Deps): boolean =>
  !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));

function useRef<T>(initial: T): { current: T } {
  const rt = current();
  const i = rt.cursor++;
  if (!(i in rt.slots)) rt.slots[i] = { current: initial };
  return rt.slots[i] as { current: T };
}

function useState<T>(initial: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void] {
  const rt = current();
  const i = rt.cursor++;
  if (!(i in rt.slots)) {
    const cell = {
      value: typeof initial === 'function' ? (initial as () => T)() : initial,
      set: (v: T | ((prev: T) => T)) => {
        const next = typeof v === 'function' ? (v as (prev: T) => T)(cell.value) : v;
        if (Object.is(next, cell.value)) return;
        cell.value = next;
        rt.schedule();
      },
    };
    rt.slots[i] = cell;
  }
  const cell = rt.slots[i] as { value: T; set: (v: T | ((prev: T) => T)) => void };
  return [cell.value, cell.set];
}

function useMemo<T>(fn: () => T, deps: Deps): T {
  const rt = current();
  const i = rt.cursor++;
  const prev = rt.slots[i] as { value: T; deps: Deps } | undefined;
  if (!prev || changed(prev.deps, deps)) rt.slots[i] = { value: fn(), deps };
  return (rt.slots[i] as { value: T }).value;
}

function useCallback<T>(fn: T, deps: Deps): T {
  return useMemo(() => fn, deps);
}

function useEffect(fn: () => Cleanup, deps?: Deps): void {
  const rt = current();
  const i = rt.effectCursor++;
  const prev = rt.effects[i];
  if (prev && !changed(prev.deps, deps)) return;
  rt.queue.push(() => {
    if (typeof prev?.cleanup === 'function') prev.cleanup();
    rt.effects[i] = { deps, cleanup: fn() };
  });
}

/** Reads the snapshot on every render; a store notification re-renders when the snapshot changed. */
function useSyncExternalStore<T>(subscribe: (onChange: () => void) => () => void, getSnapshot: () => T): T {
  const rt = current();
  const value = getSnapshot();
  const latest = useRef({ value, getSnapshot });
  latest.current = { value, getSnapshot };
  useEffect(
    () =>
      subscribe(() => {
        if (!Object.is(latest.current.getSnapshot(), latest.current.value)) rt.schedule();
      }),
    [subscribe],
  );
  return value;
}

export const fakeReact = {
  useRef,
  useState,
  useMemo,
  useCallback,
  useEffect,
  useLayoutEffect: useEffect,
  useSyncExternalStore,
};

export interface HookHandle<P, R> {
  readonly result: { current: R };
  rerender(props: P): void;
  unmount(): void;
}

export function renderHook<P, R>(hook: (props: P) => R, initialProps: P): HookHandle<P, R> {
  let props = initialProps;
  const result = { current: undefined as R };
  let busy = false;
  let dirty = false;
  const rt: Runtime = { slots: [], effects: [], queue: [], cursor: 0, effectCursor: 0, schedule: () => render() };
  function render(): void {
    if (busy) {
      dirty = true;
      return;
    }
    busy = true;
    try {
      do {
        dirty = false;
        active = rt;
        rt.cursor = 0;
        rt.effectCursor = 0;
        try {
          result.current = hook(props);
        } finally {
          active = null;
        }
        const queue = rt.queue;
        rt.queue = [];
        for (const run of queue) run();
      } while (dirty);
    } finally {
      busy = false;
    }
  }
  render();
  return {
    result,
    rerender(p: P) {
      props = p;
      render();
    },
    unmount() {
      for (const e of rt.effects) if (typeof e?.cleanup === 'function') e.cleanup();
      rt.effects = [];
    },
  };
}
