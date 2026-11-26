/** Explorer tile helpers (apps/web/src/features/maps/lib/explorerLayers.ts). */
import { describe, expect, it } from 'vitest';
import { maxVisits, visitLabels, visitSteps } from '@/features/maps/lib/explorerLayers';

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
