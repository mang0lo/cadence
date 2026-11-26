import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { DEFAULT_SETTINGS, type AthleteSettings } from '@cadence/shared';
import { createSettingsUpdater, isStaleAfter, refreshScope, withPending } from '@/lib/settings';

const KEY = ['core', 'settings', null];

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets queued promise callbacks run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const client = new QueryClient();
  client.setQueryData(KEY, DEFAULT_SETTINGS);
  const calls: { patch: Partial<AthleteSettings>; answer: ReturnType<typeof deferred<AthleteSettings>> }[] = [];
  const send = vi.fn((patch: Partial<AthleteSettings>) => {
    const answer = deferred<AthleteSettings>();
    calls.push({ patch, answer });
    return answer.promise;
  });
  const update = createSettingsUpdater(client, send);
  const shown = () => client.getQueryData<AthleteSettings>(KEY)!;
  return { client, send, calls, update, shown };
}

describe('what a settings change makes stale', () => {
  it('loads nothing again for settings of the interface alone', () => {
    expect(refreshScope({ theme: 'dark' })).toBe('none');
    expect(refreshScope({ units: 'imperial', language: 'de', mapStyle: 'outdoor', thumbnailMaps: false })).toBe('none');
    expect(refreshScope({ navOrder: ['/'], navGroups: [] })).toBe('none');
  });

  it('loads the heatmap again for privacy zones, everything for settings the analysis uses', () => {
    expect(refreshScope({ privacyZones: [] })).toBe('maps');
    for (const patch of [
      { maxHr: 180 },
      { hrZones: [110, 130, 150, 170] },
      { birthDate: '1987-04-12' },
      { weekStart: 0 as const },
      { ftp: 250 },
      { watch: 'coros' as const },
      { theme: 'dark' as const, sex: 'female' as const },
    ]) {
      expect(refreshScope(patch)).toBe('data');
    }
  });

  it('picks the queries of a scope', () => {
    expect(isStaleAfter('none', ['activities', 'list'])).toBe(false);
    expect(isStaleAfter('maps', ['maps', 'heatmap', null])).toBe(true);
    expect(isStaleAfter('maps', ['activities', 'list'])).toBe(false);
    expect(isStaleAfter('data', ['progress', 'fitness', null])).toBe(true);
    expect(isStaleAfter('data', ['core', 'athlete', null])).toBe(true);
    expect(isStaleAfter('data', ['core', 'sources', null])).toBe(true);
    expect(isStaleAfter('data', ['core', 'import-jobs'])).toBe(true);
    expect(isStaleAfter('data', ['core', 'settings', null])).toBe(false);
    expect(isStaleAfter('data', ['core', 'status', null])).toBe(false);
  });

  it('applies pending changes on top of the saved settings', () => {
    const s = withPending(DEFAULT_SETTINGS, [{ theme: 'dark' }, { units: 'imperial', theme: 'light' }]);
    expect(s.theme).toBe('light');
    expect(s.units).toBe('imperial');
    expect(s.maxHr).toBeNull();
  });
});

describe('saving settings', () => {
  it('shows a change at once and sends the requests one after the other', async () => {
    const { calls, send, update, shown } = setup();
    const a = update({ theme: 'dark' });
    const b = update({ units: 'imperial' });
    await flush();
    expect(shown().theme).toBe('dark');
    expect(shown().units).toBe('imperial');
    expect(send).toHaveBeenCalledTimes(1);

    calls[0]!.answer.resolve({ ...DEFAULT_SETTINGS, theme: 'dark' });
    await a;
    // the first answer does not take back the second change, which is still on its way
    expect(shown().units).toBe('imperial');
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(calls[1]!.patch).toEqual({ units: 'imperial' });

    calls[1]!.answer.resolve({ ...DEFAULT_SETTINGS, theme: 'dark', units: 'imperial' });
    await b;
    expect(shown()).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark', units: 'imperial' });
  });

  it('reloads only what the change affects', async () => {
    const { client, calls, update } = setup();
    const list = ['activities', 'list', null];
    const heatmap = ['maps', 'heatmap', null];
    const athlete = ['core', 'athlete', null];
    for (const k of [list, heatmap, athlete]) client.setQueryData(k, {});
    const stale = (k: unknown[]) => client.getQueryState(k)!.isInvalidated;

    const theme = update({ theme: 'dark' });
    await flush();
    calls[0]!.answer.resolve({ ...DEFAULT_SETTINGS, theme: 'dark' });
    await theme;
    expect([stale(list), stale(heatmap), stale(athlete)]).toEqual([false, false, false]);

    const zones = update({ privacyZones: [{ lat: 48.2, lon: 16.4, radiusM: 300 }] });
    await flush();
    calls[1]!.answer.resolve(DEFAULT_SETTINGS);
    await zones;
    expect([stale(list), stale(heatmap), stale(athlete)]).toEqual([false, true, false]);

    const hr = update({ maxHr: 185 });
    await flush();
    calls[2]!.answer.resolve({ ...DEFAULT_SETTINGS, maxHr: 185 });
    await hr;
    expect([stale(list), stale(heatmap), stale(athlete)]).toEqual([true, true, true]);
  });

  it('loads nothing again with refetch: false', async () => {
    const { client, calls, update } = setup();
    client.setQueryData(['activities', 'list', null], {});
    const p = update({ maxHr: 185 }, { refetch: false });
    await flush();
    calls[0]!.answer.resolve({ ...DEFAULT_SETTINGS, maxHr: 185 });
    await p;
    expect(client.getQueryState(['activities', 'list', null])!.isInvalidated).toBe(false);
  });

  it('rejects a refused change, shows the server state again and keeps sending later changes', async () => {
    const { client, calls, update } = setup();
    const bad = update({ birthDate: '0007-04-12' });
    const next = update({ theme: 'dark' });
    await flush();
    calls[0]!.answer.reject(new Error('400'));
    await expect(bad).rejects.toThrow('400');
    expect(client.getQueryState(KEY)!.isInvalidated).toBe(true);
    await flush();
    expect(calls).toHaveLength(2);
    calls[1]!.answer.resolve({ ...DEFAULT_SETTINGS, theme: 'dark' });
    await expect(next).resolves.toBeUndefined();
  });
});
