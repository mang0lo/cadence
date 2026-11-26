/**
 * The bounded cache of the share image's map tiles (apps/web/src/features/activities/lib/lru.ts).
 */
import { describe, expect, it } from 'vitest';
import { fitTracks } from '@/components/map/tiles';
import { LruMap } from '@/features/activities/lib/lru';
import { MAX_SHARE_TILES, SHARE_FORMATS, shareLayout } from '@/features/activities/lib/share';

describe('LRU map', () => {
  it('keeps at most its size and drops the least recently used entry first', () => {
    const m = new LruMap<string, number>(3);
    m.set('a', 1);
    m.set('b', 2);
    m.set('c', 3);
    expect(m.get('a')).toBe(1); // a is now the most recent
    m.set('d', 4);
    expect(m.size).toBe(3);
    expect(m.keys()).toEqual(['c', 'a', 'd']);
    expect(m.get('b')).toBeUndefined();
  });

  it('counts writing an existing key as a use', () => {
    const m = new LruMap<string, number>(2);
    m.set('a', 1);
    m.set('b', 2);
    m.set('a', 10);
    m.set('c', 3);
    expect(m.keys()).toEqual(['a', 'c']);
    expect(m.get('a')).toBe(10);
  });

  it('holds every tile of the largest share image, so a re-rendered preview loads none of them again', () => {
    // routes from a few hundred meters to a thousand kilometers, flat to tall, in every format (the share map layout)
    let largest: string[] = [];
    for (const format of SHARE_FORMATS) {
      const l = shareLayout(format, 'map', 4);
      const r = l.route!;
      const pad = { top: r.y, left: r.x, right: l.width - r.x - r.w, bottom: l.height - r.y - r.h };
      for (let k = 0; k < 400; k++) {
        const ext = 0.004 * 1.02 ** k;
        for (const aspect of [0.3, 1, 3]) {
          for (const bias of [0, -1]) {
            const fit = fitTracks([[[48.2, 16.37], [48.2 + ext * aspect, 16.37 + ext]]], l.width, l.height, pad, bias)!;
            if (fit.tiles.length > largest.length) largest = fit.tiles.map((t) => `${t.z}/${t.x}/${t.y}`);
          }
        }
      }
    }
    expect(largest.length).toBeGreaterThan(64); // a story often needs more than a few dozen tiles
    expect(largest.length).toBeLessThanOrEqual(MAX_SHARE_TILES);
    // drawn twice (an option toggled): the second time every tile comes from the cache
    const cache = new LruMap<string, number>(MAX_SHARE_TILES);
    let misses = 0;
    for (const pass of [1, 2])
      for (const key of largest) {
        if (cache.get(key) !== undefined) continue;
        if (pass === 2) misses++;
        cache.set(key, pass);
      }
    expect(misses).toBe(0);
  });

  it('removes a failed entry only while it is still the stored one', () => {
    const m = new LruMap<string, Promise<number>>(2);
    const failed = Promise.resolve(1);
    const retry = Promise.resolve(2);
    m.set('t', failed);
    m.set('t', retry);
    m.deleteIf('t', failed);
    expect(m.get('t')).toBe(retry);
    m.deleteIf('t', retry);
    expect(m.size).toBe(0);
  });
});
