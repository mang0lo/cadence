import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { apiQuery } from '@/lib/api';

/** fetch that never answers on its own; it fails like the browser's when its signal aborts. */
function hangingFetch() {
  const calls: { url: string; signal: AbortSignal | null | undefined }[] = [];
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, signal: init?.signal });
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    });
  });
  return { fetch, calls };
}

describe('useApi queries', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('cancel the request itself when TanStack cancels the query (superseded key, page left)', async () => {
    const f = hangingFetch();
    vi.stubGlobal('fetch', f.fetch);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const loading = qc.fetchQuery(apiQuery(['activities', 'list'], '/workouts', { sport: 'run' }));
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    expect(f.calls[0]!.url).toBe('/api/workouts?sport=run');
    expect(f.calls[0]!.signal?.aborted).toBe(false);
    await qc.cancelQueries({ queryKey: ['activities'] });
    expect(f.calls[0]!.signal?.aborted).toBe(true);
    await expect(loading).rejects.toBeTruthy();
  });

  it('never run without a path, whatever the options say', () => {
    expect(apiQuery(['core', 'settings'], null, undefined, { enabled: true }).enabled).toBe(false);
    expect(apiQuery(['core', 'settings'], '/settings', undefined, { enabled: false }).enabled).toBe(false);
    expect(apiQuery(['core', 'settings'], '/settings').enabled).toBe(true);
    expect(apiQuery(['core', 'settings'], '/settings', undefined, { staleTime: 5 }).staleTime).toBe(5);
  });
});
