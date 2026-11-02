import { describe, expect, it } from 'vitest';
import { profileSlice, segmentSports, valueAtDistance } from '@cadence/shared';
import { destination, haversine, type LatLon } from '../src/lib/geo';
import {
  matchSegment,
  sliceStream,
  thinPath,
  type MatchTrack,
  type SegmentPath,
} from '../src/features/maps/segment-match';
import { VIENNA, circle, trackAlong, type TestTrack } from './maps-fixtures';

/** An L-shaped road: 3 km east, then 2 km north. */
const east = destination(VIENNA[0], VIENNA[1], 90, 3000);
const north = destination(east[0], east[1], 0, 2000);
const ROAD: LatLon[] = [VIENNA, east, north];

const asTrack = (tr: TestTrack, extra: Partial<MatchTrack> = {}): MatchTrack => ({
  t: tr.t,
  lat: tr.lat,
  lon: tr.lon,
  dist: tr.dist,
  hr: tr.hr,
  moving: tr.t.map(() => 1),
  ...extra,
});

/** The segment from `fromM` to `toM` along the road, built exactly like the creation endpoint does. */
function segmentOf(track: TestTrack, fromM: number, toM: number): SegmentPath {
  return thinPath(
    sliceStream({ lat: track.lat, lon: track.lon, dist: track.dist, ele: track.ele }, fromM, toM),
  );
}

describe('profile helpers', () => {
  it('interpolates values by distance and clamps', () => {
    const d = [0, 100, 200];
    const v = [10, 20, null];
    expect(valueAtDistance(d, v, 50)).toBe(15);
    expect(valueAtDistance(d, v, 150)).toBe(20); // next value unknown → keep the last known one
    expect(valueAtDistance(d, v, -5)).toBe(10);
    expect(valueAtDistance(d, v, 500)).toBeNull();
    expect(valueAtDistance([], [], 1)).toBeNull();
  });

  it('computes gain, loss and grade without counting GPS noise as climbing', () => {
    const dist = Array.from({ length: 201 }, (_, i) => i * 5); // 1 km
    const climb = dist.map((d) => 100 + d * 0.05); // steady 5 %
    const s = profileSlice(dist, climb, 0, 1000);
    expect(s.distanceM).toBe(1000);
    expect(s.gainM).toBeGreaterThan(46);
    expect(s.gainM).toBeLessThan(52);
    expect(s.lossM).toBe(0);
    expect(s.gradePct!).toBeGreaterThan(4.5);
    expect(s.gradePct!).toBeLessThan(5.5);
    // flat road with ±0.4 m noise: no climbing at all
    const flat = dist.map((_, i) => 200 + (i % 2 ? 0.4 : -0.4));
    const f = profileSlice(dist, flat, 0, 1000);
    expect(f.gainM).toBeLessThan(2);
    expect(f.lossM).toBeLessThan(2);
    // down then up: both are counted, the net grade is zero
    const vee = dist.map((d) => 100 + Math.abs(d - 500) * 0.04);
    const v = profileSlice(dist, vee, 0, 1000);
    expect(v.lossM).toBeGreaterThan(15);
    expect(v.gainM).toBeGreaterThan(15);
    expect(Math.abs(v.gradePct!)).toBeLessThan(0.5);
    // a sub-range and missing data
    const sub = profileSlice(dist, climb, 200, 600);
    expect(sub.distanceM).toBe(400);
    expect(sub.gainM).toBeGreaterThan(17);
    expect(profileSlice(dist, undefined, 0, 500)).toMatchObject({ gainM: 0, gradePct: null });
    expect(
      profileSlice(
        dist,
        dist.map(() => null),
        0,
        500,
      ).startEleM,
    ).toBeNull();
  });

  it('groups compatible sports', () => {
    expect(segmentSports('run')).toEqual(['run', 'track_and_field']);
    expect(segmentSports('hike')).toContain('walk');
    expect(segmentSports('ride')).toContain('handcycle');
    expect(segmentSports('swim')).toEqual(['swim']);
    expect(segmentSports('run')).not.toContain('walk');
  });
});

describe('sliceStream / thinPath', () => {
  it('cuts exactly at the requested distances', () => {
    const tr = trackAlong(ROAD, { speed: 3, ele: (d) => 200 + d * 0.01 });
    const p = sliceStream({ lat: tr.lat, lon: tr.lon, dist: tr.dist, ele: tr.ele }, 1000, 2500);
    expect(p.dist[0]).toBe(0);
    expect(p.dist[p.dist.length - 1]).toBe(1500);
    expect(
      haversine(p.lat[0]!, p.lon[0]!, ...(destination(VIENNA[0], VIENNA[1], 90, 1000) as LatLon)),
    ).toBeLessThan(3);
    expect(p.ele![0]).toBeCloseTo(200 + 1000 * 0.01, 0);
    const thin = thinPath(p, 1.5);
    expect(thin.lat.length).toBeLessThan(p.lat.length / 10); // straight road → a handful of points
    expect(thin.dist[thin.dist.length - 1]).toBe(1500);
    expect(thin.ele!.length).toBe(thin.lat.length);
  });
});

describe('matchSegment', () => {
  const base = trackAlong(ROAD, { speed: 3 });
  // from 1000 m to 4000 m of the 5 km road: includes the corner
  const seg = segmentOf(base, 1000, 4000);

  it('times the same road with interpolated gate crossings', () => {
    const [m, ...rest] = matchSegment(seg, asTrack(base));
    expect(rest).toEqual([]);
    expect(m!.elapsedS).toBeCloseTo(3000 / 3, 0);
    expect(m!.startT).toBeCloseTo(1000 / 3 + 1, 0); // fixes start at t = 1
    expect(m!.trackM).toBeCloseTo(3000, -1);
    expect(m!.movingS).toBeCloseTo(m!.elapsedS, 0);
    expect(m!.avgHr).toBeGreaterThan(130);
    expect(m!.avgHr).toBeLessThan(155);
  });

  it('is accurate even when the track has only one fix every 10 s', () => {
    const sparse: TestTrack = {
      t: base.t.filter((_, i) => i % 10 === 0),
      lat: base.lat.filter((_, i) => i % 10 === 0),
      lon: base.lon.filter((_, i) => i % 10 === 0),
      dist: base.dist.filter((_, i) => i % 10 === 0),
      ele: base.ele.filter((_, i) => i % 10 === 0),
      hr: base.hr.filter((_, i) => i % 10 === 0),
    };
    const [m] = matchSegment(seg, asTrack(sparse));
    expect(Math.abs(m!.elapsedS - 1000)).toBeLessThan(2);
  });

  it('finds a faster, noisy pass and reports its time', () => {
    const fast = trackAlong(ROAD, { speed: 4.2, noiseM: 5, seed: 3 });
    const [m] = matchSegment(seg, asTrack(fast));
    expect(m).toBeTruthy();
    expect(Math.abs(m!.elapsedS - 3000 / 4.2)).toBeLessThan(15);
  });

  it('ignores tracks in the other direction, on a parallel road, with a shortcut or that stop early', () => {
    const back = trackAlong([...ROAD].reverse(), { speed: 3 });
    expect(matchSegment(seg, asTrack(back))).toEqual([]);

    const shifted = ROAD.map((p) => destination(p[0], p[1], 0, 70) as LatLon);
    const parallel = trackAlong(
      [shifted[0]!, destination(shifted[1]![0], shifted[1]![1], 0, 0), shifted[2]!],
      { speed: 3 },
    );
    expect(matchSegment(seg, asTrack(parallel))).toEqual([]);

    // cut the corner: straight from 1 km on the first leg to 1 km before the end of the second leg
    const a = destination(VIENNA[0], VIENNA[1], 90, 1000);
    const b = destination(east[0], east[1], 0, 1000);
    const shortcut = trackAlong([VIENNA, a, b, north], { speed: 3 });
    expect(matchSegment(seg, asTrack(shortcut))).toEqual([]);

    const early = trackAlong([VIENNA, east, destination(east[0], east[1], 0, 600)], { speed: 3 });
    expect(matchSegment(seg, asTrack(early))).toEqual([]);

    // far away from the segment entirely
    const elsewhere = trackAlong(
      [destination(VIENNA[0], VIENNA[1], 180, 10_000), destination(VIENNA[0], VIENNA[1], 180, 14_000)],
      { speed: 3 },
    );
    expect(matchSegment(seg, asTrack(elsewhere))).toEqual([]);
  });

  it('matches tracks that start or end exactly on the segment gates', () => {
    const exact = trackAlong(
      [destination(VIENNA[0], VIENNA[1], 90, 1000), east, destination(east[0], east[1], 0, 1000)],
      { speed: 3 },
    );
    const [m] = matchSegment(seg, asTrack(exact));
    expect(m).toBeTruthy();
    expect(m!.elapsedS).toBeCloseTo(1000, -1);
  });

  it('counts every lap on a loop segment once, without overlaps', () => {
    const lap = circle(VIENNA, 400, 72);
    const lapsTrack = trackAlong([...lap, ...lap.slice(1), ...lap.slice(1)], {
      speed: 3,
      noiseM: 3,
      seed: 5,
    });
    const loopSeg = segmentOf(
      trackAlong(lap, { speed: 3 }),
      0,
      trackAlong(lap, { speed: 3 }).dist.at(-1)! - 5,
    );
    const matches = matchSegment(loopSeg, asTrack(lapsTrack));
    expect(matches.length).toBe(3);
    for (let i = 1; i < matches.length; i++)
      expect(matches[i]!.startT).toBeGreaterThanOrEqual(matches[i - 1]!.endT - 1);
    const expected = (2 * Math.PI * 400) / 3;
    for (const m of matches) expect(Math.abs(m.elapsedS - expected)).toBeLessThan(25);
  });

  it('separates moving time from stopped time and weights heart rate by time', () => {
    // stand still for 60 s in the middle of the segment (one fix per second at the same spot)
    const at = base.dist.findIndex((d) => d >= 2500);
    const extra = 60;
    const rep = <T>(arr: T[], v: T): T[] => [
      ...arr.slice(0, at),
      ...Array<T>(extra).fill(v),
      ...arr.slice(at),
    ];
    const track: MatchTrack = {
      t: [
        ...base.t.slice(0, at),
        ...Array.from({ length: extra }, (_, k) => base.t[at]! + k),
        ...base.t.slice(at).map((x) => x + extra),
      ],
      lat: rep(base.lat, base.lat[at]!),
      lon: rep(base.lon, base.lon[at]!),
      dist: rep(base.dist, base.dist[at]!),
      hr: rep(base.hr, 100),
      moving: rep(
        base.t.map(() => 1),
        0,
      ),
    };
    const [m] = matchSegment(seg, track);
    expect(m!.elapsedS).toBeCloseTo(1000 + extra, -1);
    expect(m!.movingS!).toBeCloseTo(1000, -1);
    expect(m!.avgHr!).toBeLessThan(140); // the 60 s at 100 bpm pull the average down
  });
});
