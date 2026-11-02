import { describe, expect, it } from 'vitest';
import {
  bearing,
  bounds,
  cumulativeDistance,
  decodePolyline,
  destination,
  distanceToPath,
  encodePolyline,
  haversine,
  simplifyIndices,
  simplifyPath,
  type LatLon,
} from '../src/lib/geo';

describe('geo helpers', () => {
  it('computes great-circle distances and bearings', () => {
    // one degree of latitude ≈ 111.2 km
    expect(haversine(48, 16, 49, 16)).toBeCloseTo(111195, -1);
    expect(haversine(48.2085, 16.3731, 48.2085, 16.3731)).toBe(0);
    expect(bearing(48, 16, 49, 16)).toBeCloseTo(0, 5);
    expect(bearing(48, 16, 48, 17)).toBeCloseTo(89.6, 0);
    const [lat, lon] = destination(48.2, 16.37, 45, 1000);
    expect(haversine(48.2, 16.37, lat, lon)).toBeCloseTo(1000, 3);
    expect(Array.from(cumulativeDistance([48, 48.001, 48.002], [16, 16, 16])).map(Math.round)).toEqual([
      0, 111, 222,
    ]);
    expect(bounds([1, 3, 2], [5, 4, 6])).toEqual([4, 1, 6, 3]);
  });

  it('encodes Google polylines (reference example) and round-trips', () => {
    const pts: LatLon[] = [
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ];
    expect(encodePolyline(pts)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual(pts);
    let seed = 3;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const random: LatLon[] = Array.from({ length: 500 }, () => [rnd() * 170 - 85, rnd() * 358 - 179]);
    const back = decodePolyline(encodePolyline(random));
    random.forEach((p, i) => {
      expect(back[i]![0]).toBeCloseTo(p[0], 5);
      expect(back[i]![1]).toBeCloseTo(p[1], 5);
    });
    expect(decodePolyline('')).toEqual([]);
  });

  it('simplifies with Douglas–Peucker in meters', () => {
    // straight line with tiny wiggles → endpoints only; a real corner survives
    const line: LatLon[] = Array.from({ length: 200 }, (_, i) => [48 + i * 1e-4, 16 + (i % 2) * 1e-6]);
    expect(simplifyPath(line, 5)).toEqual([line[0], line[199]]);
    const corner: LatLon[] = [
      ...line.slice(0, 100),
      ...Array.from({ length: 100 }, (_, i): LatLon => [48 + 99e-4, 16 + (i + 1) * 1e-4]),
    ];
    const keep = simplifyIndices(
      corner.map((p) => p[0]),
      corner.map((p) => p[1]),
      5,
    );
    expect(keep).toEqual([0, 99, 199]);
    expect(
      distanceToPath(48.005, 16.001, [
        [48, 16],
        [48.01, 16],
      ]),
    ).toBeCloseTo(74, -1);
  });
});
