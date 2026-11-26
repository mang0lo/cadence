import { describe, expect, it } from 'vitest';
import { destination, encodePolylineParts, type LatLon } from '../src/lib/geo';
import { countriesAlong } from '../src/lib/places';

/** A short walk from a position: `n` points 20 m apart heading north-east. */
function walk(from: LatLon, n = 10): LatLon[] {
  return Array.from({ length: n }, (_, i) => destination(from[0], from[1], 45, i * 20));
}

describe('countriesAlong', () => {
  it('tags a walk in the centre of a border town with its own country', () => {
    // Kreuzlingen (CH) touches Konstanz (DE), Zgorzelec (PL) Görlitz (DE): ~1 km off, the other town is nearer
    expect(countriesAlong(encodePolylineParts([walk([47.65051, 9.17504])]))).toEqual(['CH']);
    expect(countriesAlong(encodePolylineParts([walk([51.15032, 15.00835])]))).toEqual(['PL']);
    expect(countriesAlong(encodePolylineParts([walk([52.34998, 14.56065])]))).toEqual(['PL']);
  });
});
