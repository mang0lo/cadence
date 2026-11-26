import { describe, expect, it } from 'vitest';
import { coarsen, keyX, keyY, tileCover } from '../src/features/maps/tiles';

/** Longitude in [-180, 180). */
const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** A walk along latitude -16.8 (Taveuni, Fiji) from `fromLon` by `steps` fixes of `dLon` degrees (~10 m). */
function walk(fromLon: number, steps: number, dLon = 0.0001) {
  const lat: number[] = [];
  const lon: number[] = [];
  for (let k = 0; k <= steps; k++) {
    lat.push(-16.8);
    lon.push(wrap(fromLon + k * dLon));
  }
  return { lat, lon };
}

describe('explorer tiles across the 180th meridian', () => {
  const Z = 17;
  const SIZE = 2 ** Z;

  it('marks the tiles on both sides of the meridian, not the whole row', () => {
    for (const [label, t] of [
      ['eastwards', walk(179.999, 20)],
      ['westwards', walk(-179.999, 20, -0.0001)],
    ] as const) {
      const tiles = tileCover(t.lat, t.lon, Z);
      const xs = [...tiles].map(keyX).sort((a, b) => a - b);
      expect(xs, label).toEqual([0, SIZE - 1]);
      expect(new Set([...tiles].map(keyY)).size, label).toBe(1);
      expect([...coarsen(tiles, 3)].map(keyX).sort((a, b) => a - b), label).toEqual([0, SIZE / 8 - 1]);
    }
  });

  it('bridges a recording gap across the meridian the short way', () => {
    // two fixes ~1.5 km apart (signal loss), one on each side: the tiles in between are filled in
    const tiles = tileCover([-16.8, -16.8], [179.993, -179.993], Z);
    const xs = [...tiles].map(keyX).sort((a, b) => a - b);
    expect(xs).toEqual([0, 1, 2, SIZE - 3, SIZE - 2, SIZE - 1]);
  });

  it('keeps a fix on the meridian itself inside the tile grid', () => {
    const tiles = tileCover([-16.8, -16.8], [179.9995, 180], Z);
    for (const k of tiles) {
      expect(keyX(k)).toBeGreaterThanOrEqual(0);
      expect(keyX(k)).toBeLessThan(SIZE);
    }
    expect([...tiles].map(keyX).sort((a, b) => a - b)).toEqual([0, SIZE - 1]);
  });
});
