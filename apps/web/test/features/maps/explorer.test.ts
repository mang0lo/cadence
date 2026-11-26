/** Explorer tile helpers (apps/web/src/features/maps/lib/explorerLayers.ts). */
import { describe, expect, it } from 'vitest';
import type { MapsExplorerTile } from '@cadence/shared';
import { firstVisitBuckets, maxVisits, visitLabels, visitSteps } from '@/features/maps/lib/explorerLayers';

describe('visit buckets', () => {
  it('finds the busiest tile among very many tiles (Math.max(...tiles) throws a RangeError there)', () => {
    const tiles = Array.from({ length: 300_000 }, (_, i) => ({ visits: (i * 7919) % 500 }));
    tiles[123_456] = { visits: 4321 };
    expect(() => Math.max(1, ...tiles.map((t) => t.visits))).toThrow(RangeError);
    expect(maxVisits(tiles)).toBe(4321);
  });

  it('counts at least one visit, also without tiles', () => {
    expect(maxVisits([])).toBe(1);
    expect(visitLabels(visitSteps(maxVisits([{ visits: 47 }])))).toEqual(['1', '2–4', '5–9', '10–21', '22+']);
  });
});

describe('first-visit buckets', () => {
  /** Tiles first visited at these times; a workout's new tiles all share its start time. */
  const tiles = (firstTs: number[]): MapsExplorerTile[] =>
    firstTs.map((ts, i) => ({
      x: i,
      y: 0,
      firstTs: ts,
      tzMin: 60,
      visits: 1,
      workoutId: ts,
      interior: false,
      cluster: false,
    }));

  it('keeps the new tiles of one activity in one bucket, so neighbouring legend ranges do not overlap', () => {
    // equal counts would cut after 2, 4, 6 and 8 tiles: through activity 1 (4 tiles) and activity 2 (3 tiles)
    const t = tiles([5, 1, 2, 1, 3, 4, 2, 1, 2, 1]);
    const b = firstVisitBuckets(t);
    const bucketsOf = (ts: number) => new Set(t.flatMap((x, i) => (x.firstTs === ts ? [b.index[i]] : [])));
    for (const ts of [1, 2, 3, 4, 5]) expect(bucketsOf(ts).size).toBe(1);
    expect(b.ranges.map((r) => [r.fromTs, r.toTs])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 5],
    ]);
    // bucket numbers are the legend rows: 0, 1, 2 … without gaps
    expect([...new Set(b.index)].sort()).toEqual([0, 1, 2, 3]);
  });

  it('still makes five equal buckets without ties, and one for a single activity', () => {
    const b = firstVisitBuckets(tiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    expect(b.ranges.map((r) => [r.fromTs, r.toTs])).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
      [9, 10],
    ]);
    const one = firstVisitBuckets(tiles([7, 7, 7, 7, 7, 7]));
    expect(one.ranges).toHaveLength(1);
    expect(one.index).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
