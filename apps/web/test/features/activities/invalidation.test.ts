/**
 * What a workout patch refreshes (apps/web/src/features/activities/lib/invalidation.ts).
 */
import { describe, expect, it } from 'vitest';
import { patchOutdates, rederives } from '@/features/activities/lib/invalidation';

const keys: (readonly unknown[])[] = [
  ['activities', 'detail', 7, null],
  ['activities', 'detail', 8, null],
  ['activities', 'streams', 7, null],
  ['activities', 'feed'],
  ['activities', 'list', { limit: 25 }],
  ['activities', 'nav', 7, null],
  ['maps', 'route', 3, null],
  ['progress', 'volume', {}],
  ['core', 'settings', null],
  ['core', 'import-jobs'],
];
/** The refreshed keys as 'feature/kind/id' (query params left out). */
const hit = (patch: Parameters<typeof patchOutdates>[0]) =>
  keys.filter(patchOutdates(patch, 7)).map((k) => k.filter((x) => typeof x === 'string' || typeof x === 'number').join('/'));

describe('workout patch: refreshed queries', () => {
  it('refreshes only the feed for a notes edit (the detail comes with the response)', () => {
    expect(hit({ notes: 'windy' })).toEqual(['activities/feed']);
    expect(hit({ notes: null })).toEqual(['activities/feed']);
  });

  it('refreshes every feature for a new name, sport or hidden flag, except core and the own detail and streams', () => {
    const all = ['activities/detail/8', 'activities/feed', 'activities/list', 'activities/nav/7', 'maps/route/3', 'progress/volume'];
    expect(hit({ name: 'Lake loop' })).toEqual(all);
    expect(hit({ sport: 'run' })).toEqual(all);
    expect(hit({ hidden: true })).toEqual(all);
    expect(hit({ name: 'x', notes: 'y' })).toEqual(all);
  });

  it('refreshes nothing for an empty patch', () => {
    expect(hit({})).toEqual([]);
  });

  it('knows which changes start a re-derivation', () => {
    expect(rederives({ sport: 'walk' })).toBe(true);
    expect(rederives({ hidden: false })).toBe(true);
    expect(rederives({ name: 'x', notes: null })).toBe(false);
  });
});
