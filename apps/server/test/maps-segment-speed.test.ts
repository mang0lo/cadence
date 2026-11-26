import { describe, expect, it } from 'vitest';
import { destination, type LatLon } from '../src/lib/geo';
import { matchSegment, sliceStream, thinPath, type MatchTrack } from '../src/features/maps/segment-match';
import { VIENNA, rng, trackAlong, type TestTrack } from './maps-fixtures';

/** A winding 40 km course: 400 m legs with a random turn of up to ±60° each. */
function windingCourse(seed: number): LatLon[] {
  const rand = rng(seed);
  const pts: LatLon[] = [VIENNA];
  let bearing = 90;
  for (let i = 0; i < 100; i++) {
    bearing += (rand() - 0.5) * 120;
    const p = pts[pts.length - 1]!;
    pts.push(destination(p[0], p[1], bearing, 400));
  }
  return pts;
}

const asTrack = (tr: TestTrack): MatchTrack => ({
  t: tr.t,
  lat: tr.lat,
  lon: tr.lon,
  dist: tr.dist,
  moving: tr.t.map(() => 1),
});

describe('segment matching cost', () => {
  it('matches a long segment against dense tracks in linear time', () => {
    const course = windingCourse(7);
    const source = trackAlong(course, { speed: 3 });
    const seg = thinPath(
      sliceStream({ lat: source.lat, lon: source.lon, dist: source.dist, ele: source.ele }, 0, 39_900),
    );
    // 1 Hz tracks of the same course (13 300 fixes each) and one 70 m off it
    const tracks = Array.from({ length: 6 }, (_, k) => trackAlong(course, { speed: 3, noiseM: 4, seed: k + 1 }));
    const off = trackAlong(
      course.map((p) => destination(p[0], p[1], 0, 70) as LatLon),
      { speed: 3 },
    );
    const t0 = performance.now();
    const results = tracks.map((tr) => matchSegment(seg, asTrack(tr)));
    const offResult = matchSegment(seg, asTrack(off));
    const ms = performance.now() - t0;
    for (const r of results) {
      expect(r.length).toBe(1);
      expect(Math.abs(r[0]!.elapsedS - 39_900 / 3)).toBeLessThan(60);
    }
    expect(offResult).toEqual([]);
    // checking every edge for every sample took about 150 ms per track here; the grid needs a few ms
    expect(ms).toBeLessThan(300);
  });
});
