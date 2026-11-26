import { describe, expect, it } from 'vitest';
import { cumulativeDistance, destination, type LatLon } from '../src/lib/geo';
import { matchSegment, sliceStream, thinPath, type MatchTrack } from '../src/features/maps/segment-match';
import { VIENNA, trackAlong } from './maps-fixtures';

/** A point `x` meters east of VIENNA on a straight road. */
const along = (x: number): LatLon => destination(VIENNA[0], VIENNA[1], 90, x);

/** The segment from 300 m to 1500 m of the road (1.2 km), built like the creation endpoint does. */
const road = trackAlong([VIENNA, along(2000)], { speed: 3 });
const SEG = thinPath(sliceStream({ lat: road.lat, lon: road.lon, dist: road.dist, ele: road.ele }, 300, 1500));

/**
 * 1 Hz track along the road: from the first position to each next one at `speed` m/s (back and forth allowed);
 * `{ standS }` stands still for that many seconds.
 */
function shuttle(stops: (number | { standS: number })[], speed = 3): MatchTrack {
  const xs: number[] = [];
  const moving: number[] = [];
  let x = stops[0] as number;
  xs.push(x);
  moving.push(1);
  for (const s of stops.slice(1)) {
    if (typeof s === 'number') {
      const dir = Math.sign(s - x);
      while (Math.abs(s - x) > speed) {
        x += dir * speed;
        xs.push(x);
        moving.push(1);
      }
      x = s;
      xs.push(x);
      moving.push(1);
    } else
      for (let k = 0; k < s.standS; k++) {
        xs.push(x);
        moving.push(0);
      }
  }
  const pts = xs.map(along);
  const lat = pts.map((p) => p[0]);
  const lon = pts.map((p) => p[1]);
  return { t: xs.map((_, i) => i + 1), lat, lon, dist: Array.from(cumulativeDistance(lat, lon)), moving };
}

describe('segment gates: where an effort starts', () => {
  it('a plain pass takes the segment length at the given speed', () => {
    const [m, ...rest] = matchSegment(SEG, shuttle([250, 1600]));
    expect(rest).toEqual([]);
    expect(m!.elapsedS).toBeCloseTo(400, 0);
  });

  it('starts at the last start crossing: a turn back and a wait behind the line are not timed', () => {
    // crosses the start, runs 80 m in, turns back to 20 m behind the line, waits 2 minutes, then runs the segment
    const [m, ...rest] = matchSegment(SEG, shuttle([250, 380, 280, { standS: 120 }, 1600]));
    expect(rest).toEqual([]);
    expect(m!.elapsedS).toBeGreaterThan(395);
    expect(m!.elapsedS).toBeLessThan(405);
    expect(m!.trackM).toBeCloseTo(1200, -1);
    expect(m!.movingS!).toBeGreaterThan(395);
  });

  it('starts at the last start crossing when GPS jitter crosses the line while waiting', () => {
    const [m, ...rest] = matchSegment(
      SEG,
      shuttle([250, 296, 303, 297, 304, 298, { standS: 60 }, 302, 297, 1600], 3),
    );
    expect(rest).toEqual([]);
    expect(m!.elapsedS).toBeGreaterThan(395);
    expect(m!.elapsedS).toBeLessThan(406);
  });
});
