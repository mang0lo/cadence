import { describe, expect, it } from 'vitest';
import { POLYLINE_PART_SEPARATOR } from '@cadence/shared';
import { boundsOf, decodePolyline, decodePolylineParts, toLngLat } from '@/lib/polyline';

// Google's reference example for the encoded polyline format
const GOOGLE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const GOOGLE_POINTS: [number, number][] = [
  [38.5, -120.2],
  [40.7, -120.95],
  [43.252, -126.453],
];

describe('lib/polyline', () => {
  it('decodes the reference polyline', () => {
    expect(decodePolyline(GOOGLE)).toEqual(GOOGLE_POINTS);
    expect(decodePolyline('')).toEqual([]);
  });

  it('decodes every part of a multi-part polyline', () => {
    const two = `${GOOGLE}${POLYLINE_PART_SEPARATOR}${GOOGLE}`;
    expect(decodePolylineParts(two)).toEqual([GOOGLE_POINTS, GOOGLE_POINTS]);
    expect(decodePolyline(two)).toEqual([...GOOGLE_POINTS, ...GOOGLE_POINTS]);
  });

  it('converts to GeoJSON order and computes bounds', () => {
    expect(toLngLat([[48.2, 16.37]])).toEqual([[16.37, 48.2]]);
    expect(boundsOf(GOOGLE_POINTS)).toEqual([-126.453, 38.5, -120.2, 43.252]);
    expect(boundsOf([])).toBeNull();
  });
});
