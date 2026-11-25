/**
 * The bounded cache of the share image's map tiles (apps/web/src/features/activities/lib/lru.ts).
 */
import { describe, expect, it } from 'vitest';
import { LruMap } from '@/features/activities/lib/lru';

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
