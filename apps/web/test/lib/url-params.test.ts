/**
 * Filters kept in the URL (apps/web/src/lib/urlParams.ts): one patcher for the progress pages, the activities list
 * and the health day pickers. Changes replace the history entry (filter clicks do not pile up behind the back button).
 */
import { describe, expect, it, vi } from 'vitest';
import { patchParams, useUrlParams } from '@/lib/urlParams';
import { patchListParams } from '@/features/activities/lib/listParams';
import { renderHook } from '../features/maps/fake-react';

vi.mock('react', async () => (await import('../features/maps/fake-react')).fakeReact);

/** react-router's useSearchParams over one URL: what the page set, and how. */
const url = vi.hoisted(() => ({
  params: new URLSearchParams(),
  calls: [] as { replace?: boolean }[],
}));
vi.mock('react-router', () => ({
  useSearchParams: () => [
    url.params,
    (next: URLSearchParams | ((prev: URLSearchParams) => URLSearchParams), opts?: { replace?: boolean }) => {
      url.params = typeof next === 'function' ? next(url.params) : next;
      url.calls.push(opts ?? {});
    },
  ],
}));

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
    url.calls = [];
    const h = renderHook(() => useUrlParams(), {});
    const [, patch] = h.result.current;
    patch({ period: '3m' });
    patch({ sport: null });
    expect(url.params.toString()).toBe('period=3m');
    expect(url.calls).toEqual([{ replace: true }, { replace: true }]);
  });

  it('applies a page’s own rules and clears everything', () => {
    // the activities list: every change except paging goes back to page 1
    url.params = new URLSearchParams('q=run&page=4');
    url.calls = [];
    const h = renderHook(() => useUrlParams(patchListParams), {});
    const [, patch, clear] = h.result.current;
    patch({ gps: '1' });
    expect(url.params.toString()).toBe('q=run&gps=1');
    patch({ page: '2' });
    expect(url.params.toString()).toBe('q=run&gps=1&page=2');
    clear();
    expect(url.params.toString()).toBe('');
    expect(url.calls.every((c) => c.replace)).toBe(true);
  });
});
