import { describe, expect, it } from 'vitest';
import { destination, encodePolylineParts, haversine, type LatLon } from '../src/lib/geo';
import { countriesAlong } from '../src/lib/places';

/** A short walk from a position: `n` points 20 m apart heading north-east. */
function walk(from: LatLon, n = 10): LatLon[] {
  return Array.from({ length: n }, (_, i) => destination(from[0], from[1], 45, i * 20));
}

/** Points about `stepM` apart on straight lines between the given positions, like a stored (simplified) route. */
function detailed(points: LatLon[], stepM = 200): LatLon[] {
  const out: LatLon[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const n = Math.max(1, Math.round(haversine(a[0], a[1], b[0], b[1]) / stepM));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

describe('countriesAlong', () => {
  it('finds the countries a detailed route passes between its start and end', () => {
    // Munich → Innsbruck → Bolzano with a point every 200 m: no segment is long enough to be sampled on its own
    const tour = detailed([
      [48.137, 11.575],
      [47.269, 11.404],
      [46.498, 11.354],
    ]);
    expect(tour.length).toBeGreaterThan(900);
    expect(countriesAlong(encodePolylineParts([tour]))).toEqual(['DE', 'AT', 'IT']);
    // a loop from Vienna to Bratislava and back
    const vienna: LatLon = [48.2082, 16.3738];
    expect(countriesAlong(encodePolylineParts([detailed([vienna, [48.1486, 17.1077], vienna])]))).toEqual(['AT', 'SK']);
  });

  it('starts every part of a route on its own', () => {
    // paused on a train from Salzburg to Munich: two parts, each only a few hundred metres long
    const parts = [walk([47.8095, 13.055]), walk([48.137, 11.575])];
    expect(countriesAlong(encodePolylineParts(parts))).toEqual(['AT', 'DE']);
  });

  it('tags a walk in the centre of a border town with its own country', () => {
    // Kreuzlingen (CH) touches Konstanz (DE), Zgorzelec (PL) Görlitz (DE): ~1 km off, the other town is nearer
    expect(countriesAlong(encodePolylineParts([walk([47.65051, 9.17504])]))).toEqual(['CH']);
    expect(countriesAlong(encodePolylineParts([walk([51.15032, 15.00835])]))).toEqual(['PL']);
    expect(countriesAlong(encodePolylineParts([walk([52.34998, 14.56065])]))).toEqual(['PL']);
  });
});
