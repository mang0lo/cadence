/**
 * Comparing two activities (web: apps/web/src/features/activities/lib/compare.ts — pure functions, tested here because
 * the web workspace has no test runner).
 */
import { describe, expect, it } from 'vitest';
import type { WorkoutStreams } from '@cadence/shared';
import {
  align,
  clockOf,
  commonPauses,
  gridValue,
  positionAt,
  replayAt,
  replayClock,
  routeSeparation,
  sideSeries,
  smoothGrid,
  summaryRows,
  valueAtNoBreak,
} from '@/features/activities/lib/compare';
import { prepareStreams, type Prepared } from '@/features/activities/lib/streams';

const M_PER_DEG = 111_320;

/**
 * 1 Hz track heading east from (48.2, 16.37) at speed(t) m/s. `stops` are [from, to) seconds standing still (not
 * moving); `breakAt` starts a new track part at that sample, `jumpM` north of the previous fix (no distance counted).
 */
function synth(
  seconds: number,
  o: {
    speed?: (t: number) => number;
    stops?: [number, number][];
    hr?: (t: number) => number;
    ele?: (d: number) => number;
    breakAt?: number;
    jumpM?: number;
    northM?: number;
    gps?: boolean;
  } = {},
): WorkoutStreams {
  const lat0 = 48.2 + (o.northM ?? 0) / M_PER_DEG;
  const lon0 = 16.37;
  const kx = M_PER_DEG * Math.cos((48.2 * Math.PI) / 180);
  const s: Required<Pick<WorkoutStreams, 't' | 'lat' | 'lon' | 'dist' | 'speed' | 'moving' | 'hr' | 'ele'>> =
    {
      t: [],
      lat: [],
      lon: [],
      dist: [],
      speed: [],
      moving: [],
      hr: [],
      ele: [],
    };
  let d = 0;
  let east = 0;
  let north = 0;
  for (let i = 0; i <= seconds; i++) {
    const stopped = (o.stops ?? []).some(([a, b]) => i > a && i <= b);
    const isBreak = i === o.breakAt;
    const v = stopped || isBreak ? 0 : (o.speed?.(i) ?? 3);
    if (i > 0 && !isBreak) {
      d += v;
      east += v;
    }
    if (isBreak) north += o.jumpM ?? 5000;
    s.t.push(i);
    s.lat.push(lat0 + north / M_PER_DEG);
    s.lon.push(lon0 + east / kx);
    s.dist.push(d);
    s.speed.push(v);
    s.moving.push(i === 0 || stopped || isBreak ? 0 : 1);
    s.hr.push(o.hr ? o.hr(i) : 140);
    s.ele.push(o.ele ? o.ele(d) : 200);
  }
  const out: WorkoutStreams = { ...s };
  if (o.gps === false) {
    delete out.lat;
    delete out.lon;
  }
  if (o.breakAt !== undefined) out.breaks = [o.breakAt];
  return out;
}

const prep = (s: WorkoutStreams): Prepared => prepareStreams(s)!;

describe('compare: clocks', () => {
  it('counts moving time without stops (capped like the server) and elapsed time as is', () => {
    const P = prep(synth(600, { stops: [[100, 160]] }));
    const moving = clockOf(P, 'moving');
    const elapsed = clockOf(P, 'elapsed');
    expect(elapsed[P.n - 1]).toBe(600);
    expect(moving[P.n - 1]).toBe(600 - 60); // the stop is not moving time
    // flat while stopped
    expect(moving[160]).toBe(moving[100]);
  });
});

describe('compare: alignment by distance', () => {
  it('compares over the common (shorter) distance; the gap grows for the faster one', () => {
    const A = prep(synth(1000, { speed: () => 3 })); // 3000 m
    const B = prep(synth(1000, { speed: () => 2.5 })); // 2500 m
    const al = align(A, B, 'moving')!;
    expect(al.mode).toBe('distance');
    expect(al.span).toBeCloseTo(2500, 6);
    expect(al.x[0]).toBe(0);
    expect(al.x[al.x.length - 1]).toBe(al.span);
    expect(al.x.length).toBeLessThanOrEqual(1000);
    const gap = al.gap!;
    // A needs d / 3 s, B d / 2.5 s: positive = A ahead
    expect(gap[0]).toBeCloseTo(0, 6);
    expect(gap[gap.length - 1]).toBeCloseTo(2500 / 2.5 - 2500 / 3, 0);
    for (let k = 1; k < gap.length; k++) expect(gap[k]!).toBeGreaterThanOrEqual(gap[k - 1]! - 1e-9);
    expect(gridValue(al, gap, 1500)).toBeCloseTo(1500 / 2.5 - 1500 / 3, 0);
    // swapping the sides flips the sign
    const swapped = align(B, A, 'moving')!;
    expect(swapped.gap![swapped.gap!.length - 1]).toBeCloseTo(-gap[gap.length - 1]!, 6);
  });

  it('moving time leaves a stop out of the gap, elapsed time counts it', () => {
    const A = prep(synth(1200, { stops: [[300, 360]] })); // 3 m/s with a 60 s stop at 900 m
    const B = prep(synth(1200));
    const moving = align(A, B, 'moving')!;
    const elapsed = align(A, B, 'elapsed')!;
    const at = (al: typeof moving, d: number) => gridValue(al, al.gap!, d);
    expect(Math.abs(at(moving, 2000))).toBeLessThan(1.5);
    expect(at(elapsed, 600)).toBeCloseTo(0, 0);
    expect(at(elapsed, 2000)).toBeCloseTo(-60, 0); // B ahead by the length of the stop
  });

  it('never interpolates across a track break and marks it on the grid', () => {
    const A = prep(synth(1000, { breakAt: 500, jumpM: 5000 }));
    const B = prep(synth(1000));
    expect(A.breaks).toEqual([500]);
    // halfway through the jump segment the position stays at the last fix before it
    expect(positionAt(A, 499.5)).toEqual([A.lon![499], A.lat![499]]);
    expect(positionAt(A, 500)).toEqual([A.lon![500], A.lat![500]]);
    expect(valueAtNoBreak(A.lat, 499.5, A.breaks)).toBe(A.lat![499]);
    const al = align(A, B, 'moving')!;
    expect(al.breaksA).toHaveLength(1);
    expect(al.breaksB).toHaveLength(0);
    const k = al.breaksA[0]!;
    // first grid point of the new part: at or beyond the distance where it starts, the one before is not
    expect(al.x[k]!).toBeGreaterThanOrEqual(A.dist![500]! - 1e-6);
    expect(al.x[k - 1]!).toBeLessThan(A.dist![500]!);
    // the grid point of the new part is placed on the new part (5 km north), the one before on the old one
    expect(positionAt(A, al.iA[k]!)![1]).toBeGreaterThan(A.lat![499]! + 0.04);
    expect(positionAt(A, al.iA[k - 1]!)![1]).toBeCloseTo(A.lat![0]!, 6);
  });

  it('aligns on the clock when one of them has no distance', () => {
    const A = prep(synth(900, { hr: (t) => 120 + t / 30 }));
    const s = synth(600, { gps: false });
    delete s.dist;
    delete s.speed;
    const B = prep(s);
    const al = align(A, B, 'elapsed')!;
    expect(al.mode).toBe('time');
    expect(al.span).toBe(600);
    expect(al.gap).toBeNull();
    const a = sideSeries(A, al, 'a');
    expect(gridValue(al, a.hr!, 300)).toBeCloseTo(130, 0);
    expect(sideSeries(B, al, 'b').speed).toBeNull();
  });

  it('returns null for too little to compare', () => {
    const A = prep(synth(20)); // 60 m and 20 s
    const B = prep(synth(900));
    expect(align(A, B, 'moving')).toBeNull();
  });
});

describe('compare: series on the grid', () => {
  it('bins speed while moving, heart rate and elevation per distance', () => {
    const A = prep(
      synth(1000, { stops: [[300, 360]], hr: (t) => (t < 500 ? 130 : 160), ele: (d) => 100 + d / 100 }),
    );
    const B = prep(synth(1000, { speed: () => 2.5 }));
    const al = align(A, B, 'moving')!;
    const a = sideSeries(A, al, 'a');
    const b = sideSeries(B, al, 'b');
    expect(gridValue(al, a.speed!, 500)).toBeCloseTo(3, 6);
    expect(gridValue(al, b.speed!, 500)).toBeCloseTo(2.5, 6);
    // no stopped samples in the speed bins
    for (const v of a.speed!) if (v === v) expect(v).toBeGreaterThan(2.9);
    expect(gridValue(al, a.hr!, 600)).toBeCloseTo(130, 6);
    expect(gridValue(al, a.hr!, 2000)).toBeCloseTo(160, 6);
    expect(gridValue(al, a.ele!, 1200)).toBeCloseTo(112, 1);
  });
});

describe('compare: smoothing', () => {
  it('averages over ±half points, keeps gaps and never mixes track parts', () => {
    const ys = Float64Array.from([1, 2, 3, NaN, 5, 100, 100, 100]);
    const s = smoothGrid(ys, 1, [5]);
    expect(s[1]).toBeCloseTo(2, 9);
    expect(s[2]).toBeCloseTo(2.5, 9); // (2 + 3) / 2, the NaN neighbour does not count
    expect(Number.isNaN(s[3]!)).toBe(true);
    expect(s[4]).toBeCloseTo(5, 9); // the next part (from index 5) is not mixed in
    expect(s[5]).toBe(100);
  });
});

describe('compare: replay', () => {
  it('runs on the later finish and reports the lead', () => {
    const A = prep(synth(1000, { speed: () => 3 }));
    const B = prep(synth(1200, { speed: () => 2.5 }));
    const al = align(A, B, 'moving')!;
    const clock = replayClock(A, B, al);
    expect(clock.duration).toBe(1200); // B's moving time
    expect(clock.pauses).toEqual([]);
    const r = replayAt(A, B, al, 400);
    expect(r.lead!).toBeCloseTo(400 * 0.5, 0);
    // gap at the distance of the one behind (B at ~1000 m): A passed it 1000/2.5 − 1000/3 s earlier
    expect(r.gap!).toBeCloseTo(r.dB! / 2.5 - r.dB! / 3, 0);
    expect(r.gap!).toBeGreaterThan(0);
    // A has finished: it stays at its end
    const late = replayAt(A, B, al, 1100);
    expect(late.dA!).toBeCloseTo(A.totalDist, 6);
  });

  it('skips only the time in which both stood still (and the other one’s pauses once one has finished)', () => {
    expect(commonPauses([[100, 200]], 1000, [[150, 300]], 1000)).toEqual([[150, 200]]);
    expect(commonPauses([[100, 105]], 1000, [[100, 300]], 1000)).toEqual([]);
    // A finished at 500, B paused 600–700 and finished at 900
    expect(commonPauses([], 500, [[600, 700]], 900)).toEqual([[600, 700]]);
  });

  it('elapsed replays skip common pauses', () => {
    const A = prep(synth(1000, { stops: [[200, 300]] }));
    const B = prep(synth(1000, { stops: [[220, 320]] }));
    const al = align(A, B, 'elapsed')!;
    const clock = replayClock(A, B, al);
    expect(clock.duration).toBe(1000);
    expect(clock.pauses.length).toBe(1);
    expect(clock.pauses[0]![0]).toBeGreaterThanOrEqual(219);
    expect(clock.pauses[0]![1]).toBeLessThanOrEqual(301);
  });
});

describe('compare: routes & summary', () => {
  it('measures how far apart the routes are at the same distance', () => {
    const A = prep(synth(1000));
    const same = prep(synth(1000, { speed: () => 2.9 }));
    const north = prep(synth(1000, { northM: 500 }));
    expect(routeSeparation(A, same, align(A, same, 'moving')!)!).toBeLessThan(1);
    expect(routeSeparation(A, north, align(A, north, 'moving')!)!).toBeCloseTo(500, -1);
  });

  it('lists the metrics either has, with A − B', () => {
    const base = {
      distanceM: 10_000,
      movingS: 3000,
      durationS: 3000,
      elapsedS: 3100,
      avgSpeed: 10_000 / 3000,
      avgHr: 150,
      maxHr: 170,
      elevationGainM: 80,
      avgPower: null,
      avgCadence: null,
    };
    const rows = summaryRows(
      base,
      { ...base, movingS: 3060, avgHr: null, avgSpeed: 10_000 / 3060 },
      { a: 2950, b: 3010 },
    );
    const keys = rows.map((r) => r.key);
    expect(keys).toEqual([
      'distance',
      'commonTime',
      'moving',
      'elapsed',
      'speed',
      'avgHr',
      'maxHr',
      'elevation',
    ]);
    const moving = rows.find((r) => r.key === 'moving')!;
    expect(moving.diff).toBe(-60);
    expect(moving.better).toBe('lower');
    const hr = rows.find((r) => r.key === 'avgHr')!;
    expect(hr).toMatchObject({ a: 150, b: null, diff: null, better: null });
    expect(rows.find((r) => r.key === 'commonTime')!.diff).toBe(-60);
  });
});
