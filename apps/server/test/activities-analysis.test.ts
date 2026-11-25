import { describe, expect, it } from 'vitest';
import { PROGRESS_POWER_DURATIONS, type WorkoutStreams } from '@cadence/shared';
import {
  aerobicDecoupling,
  analyzeActivity,
  efficiencyFactor,
  POWER_PEAK_WINDOWS,
  statsBetween,
  toSeries,
} from '../src/features/activities/analysis';
import { bestAverages, powerParts } from '../src/features/progress/power-math';

/** Streams with one sample every `step` seconds; generators get the time (s) or the distance (m). */
function synth(
  seconds: number,
  o: {
    step?: number;
    speed?: (t: number) => number;
    hr?: (t: number) => number | null;
    power?: (t: number) => number | null;
    ele?: (d: number) => number;
  } = {},
): WorkoutStreams {
  const step = o.step ?? 1;
  const t: number[] = [];
  const dist: number[] = [];
  const speed: number[] = [];
  const hr: (number | null)[] = [];
  const power: (number | null)[] = [];
  const ele: number[] = [];
  const moving: number[] = [];
  let d = 0;
  for (let x = 0; x <= seconds; x += step) {
    const v = o.speed ? o.speed(x) : 3;
    if (x > 0) d += v * step;
    t.push(x);
    dist.push(d);
    speed.push(v);
    hr.push(o.hr ? o.hr(x) : null);
    power.push(o.power ? o.power(x) : null);
    ele.push(o.ele ? o.ele(d) : 100);
    moving.push(x === 0 ? 0 : 1);
  }
  const s: WorkoutStreams = { t, dist, speed, moving, ele };
  if (o.hr) s.hr = hr;
  if (o.power) s.power = power;
  return s;
}

const run = (streams: WorkoutStreams, sport = 'run') =>
  analyzeActivity({ sport, startTs: 0, endTs: streams.t.at(-1)!, lapLengthM: null, streams, events: [] });

describe('heart rate coverage of sparse streams', () => {
  it('counts heart rate on points a minute or more apart in full', () => {
    const minute = toSeries(synth(3600, { step: 60, hr: () => 150 }));
    expect(aerobicDecoupling(minute, minute.speed, 'pace')!.pct).toBeCloseTo(0, 6);
    const sparse = run(synth(3600, { step: 90, hr: () => 150 }));
    expect(sparse.decoupling).not.toBeNull();
    expect(sparse.efficiency).toMatchObject({ basis: 'gap' });
    expect(sparse.efficiency!.value).toBeCloseTo((3 * 60) / 150, 6);
  });

  it('still needs heart rate on most of the moving time', () => {
    const s = toSeries(synth(3600, { step: 90, hr: (t) => (t < 1200 ? 150 : null) }));
    expect(efficiencyFactor(s, 3, 'speed')).toBeNull();
    expect(aerobicDecoupling(s, s.speed, 'pace')).toBeNull();
  });
});

describe('peak power (same as the power curve)', () => {
  it('uses the power curve best averages and ignores sensor glitches', () => {
    const streams = synth(3600, {
      speed: () => 8,
      hr: () => 140,
      power: (t) => (t === 100 ? 65535 : t >= 1000 && t < 1300 ? 320 : 200),
    });
    const p = run(streams, 'ride').power!;
    expect(p.maxW).toBe(320);
    const bests = bestAverages(powerParts({ ...streams, power: streams.power!.map((w) => (w! > 3000 ? null : w)) }), POWER_PEAK_WINDOWS);
    expect(p.peaks).toEqual(bests.map((b) => ({ durationS: b.durationS, watts: b.watts })));
    expect(p.peaks.find((x) => x.durationS === 5)!.watts).toBe(320);
    expect(p.peaks.find((x) => x.durationS === 300)!.watts).toBe(320);
    for (const w of POWER_PEAK_WINDOWS) expect(PROGRESS_POWER_DURATIONS).toContain(w);
  });

  it('never averages across a track break', () => {
    // two 10-minute parts at 300 W, a paused train ride between them: no 20-minute best
    const t: number[] = [];
    const power: number[] = [];
    for (let i = 0; i <= 600; i++) (t.push(i), power.push(300));
    for (let i = 0; i <= 600; i++) (t.push(4200 + i), power.push(300));
    const a = run({ t, power, breaks: [601], moving: t.map((_, i) => (i === 0 || i === 601 ? 0 : 1)) }, 'ride');
    expect(a.power!.peaks.map((x) => x.durationS)).toEqual([5, 60, 300]);
  });
});

describe('climbs and laps across a track break', () => {
  /** Hike up 5 %, paused for a cable car (+500 m), then up 5 % again. */
  function cableCar(): WorkoutStreams {
    const t: number[] = [];
    const dist: number[] = [];
    const ele: number[] = [];
    const moving: number[] = [];
    const hr: number[] = [];
    for (let i = 0; i < 1000; i++) {
      t.push(i);
      dist.push(i);
      ele.push(1000 + 0.05 * i);
      moving.push(i ? 1 : 0);
      hr.push(130);
    }
    for (let i = 0; i < 1000; i++) {
      t.push(2800 + i);
      dist.push(999 + i);
      ele.push(1550 + 0.05 * i);
      moving.push(i ? 1 : 0);
      hr.push(130);
    }
    return { t, dist, ele, moving, hr, speed: t.map(() => 1), breaks: [1000] };
  }

  it('detects one climb per part with the real elevations and without the ride in its time', () => {
    const a = analyzeActivity({ sport: 'hike', startTs: 0, endTs: 3800, lapLengthM: null, streams: cableCar(), events: [] });
    expect(a.climbs).toHaveLength(2);
    const [c1, c2] = a.climbs as [(typeof a.climbs)[0], (typeof a.climbs)[0]];
    for (const c of [c1, c2]) {
      expect(c.gainM).toBeGreaterThan(40);
      expect(c.gainM).toBeLessThan(51);
      expect(c.durationS).toBeLessThan(1000);
      expect(c.vam).toBeGreaterThan(160);
    }
    expect(c1.startEleM).toBeLessThan(1010);
    expect(c1.endEleM).toBeLessThan(1051);
    expect(c2.startEleM).toBeGreaterThan(1545);
    expect(c2.endEleM).toBeGreaterThan(1590);
    expect(c2.startT).toBeGreaterThanOrEqual(2800);
  });

  it('does not count the height of the ride as lap climbing', () => {
    const s = toSeries(cableCar());
    const st = statsBetween(s, 0, 3800);
    expect(st.elevGainM!).toBeGreaterThan(95);
    expect(st.elevGainM!).toBeLessThan(101);
    expect(st.movingS).toBeCloseTo(1998, 6);
  });
});
