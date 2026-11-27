/**
 * Filters kept in the URL (apps/web/src/lib/urlParams.ts): one patcher for the progress pages, the activities list
 * and the health day pickers. Changes replace the history entry (filter clicks do not pile up behind the back button).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { patchParams, useUrlParams } from '@/lib/urlParams';
import { patchListParams } from '@/features/activities/lib/listParams';
import { renderHook } from '../features/maps/fake-react';

vi.mock('react', async () => (await import('../features/maps/fake-react')).fakeReact);

/**
 * react-router's useSearchParams over one URL, as the real one behaves: a function update gets a copy of the params of
 * the render that made the setter (not the live URL), and a new URL renders the page again.
 */
const url = vi.hoisted(() => ({
  params: new URLSearchParams(),
  calls: [] as { replace?: boolean }[],
  listeners: new Set<() => void>(),
}));
vi.mock('react-router', async () => {
  const { fakeReact } = await import('../features/maps/fake-react');
  const subscribe = (onChange: () => void) => {
    url.listeners.add(onChange);
    return () => void url.listeners.delete(onChange);
  };
  return {
    useSearchParams: () => {
      const params = fakeReact.useSyncExternalStore(subscribe, () => url.params);
      const setParams = (
        next: URLSearchParams | ((prev: URLSearchParams) => URLSearchParams),
        opts?: { replace?: boolean },
      ) => {
        url.params = typeof next === 'function' ? next(new URLSearchParams(params)) : next;
        url.calls.push(opts ?? {});
        for (const onChange of [...url.listeners]) onChange();
      };
      return [params, setParams];
    },
  };
});

beforeEach(() => {
  url.calls = [];
  url.listeners.clear();
});

describe('patchParams', () => {
  it('sets and deletes keys and keeps the others', () => {
    const prev = new URLSearchParams('sport=run&effort=5k&scope=thisYear');
    expect(patchParams(prev, { sport: 'ride', effort: null }).toString()).toBe('sport=ride&scope=thisYear');
    expect(patchParams(prev, { unit: 'wkg' }).toString()).toBe('sport=run&effort=5k&scope=thisYear&unit=wkg');
    // an emptied search box leaves no `q=` behind
    expect(patchParams(prev, { scope: '' }).toString()).toBe('sport=run&effort=5k');
    // the previous params stay untouched
    expect(prev.toString()).toBe('sport=run&effort=5k&scope=thisYear');
  });
});

describe('useUrlParams', () => {
  it('patches the current URL and replaces the history entry', () => {
    url.params = new URLSearchParams('sport=run&period=12m');
    const h = renderHook(() => useUrlParams(), {});
    h.result.current[1]({ period: '3m' });
    // the new URL renders the page again, and the patch of that render starts from it
    expect(h.result.current[0].toString()).toBe('sport=run&period=3m');
    h.result.current[1]({ sport: null });
    expect(url.params.toString()).toBe('period=3m');
    expect(url.calls).toEqual([{ replace: true }, { replace: true }]);
  });

  it('starts from the params of its render, like setSearchParams: one event, one patch', () => {
    url.params = new URLSearchParams('sport=run&period=12m');
    const [, patch] = renderHook(() => useUrlParams(), {}).result.current;
    patch({ period: '3m' });
    patch({ sport: null });
    // the second patch of the same render does not see the first one
    expect(url.params.toString()).toBe('period=12m');
  });

  it('applies a page’s own rules and clears everything', () => {
    // the activities list: every change except paging goes back to page 1
    url.params = new URLSearchParams('q=run&page=4');
    const h = renderHook(() => useUrlParams(patchListParams), {});
    h.result.current[1]({ gps: '1' });
    expect(url.params.toString()).toBe('q=run&gps=1');
    h.result.current[1]({ page: '2' });
    expect(url.params.toString()).toBe('q=run&gps=1&page=2');
    h.result.current[2]();
    expect(url.params.toString()).toBe('');
    expect(url.calls.every((c) => c.replace)).toBe(true);
  });
});
