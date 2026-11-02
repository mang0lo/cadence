import { describe, expect, it } from 'vitest';
import { climbCategory, gradeCostFactor, type WorkoutStreams } from '@cadence/shared';
import {
  aerobicDecoupling,
  analyzeActivity,
  climbsOf,
  detectClimbRanges,
  efficiencyFactor,
  elevationGrid,
  gradeAdjustedSpeed,
  lapsFromEvents,
  movingSeconds,
  normalizedPower,
  peakPower,
  powerAnalysis,
  powerPerSecond,
  statsBetween,
  timeAtDistance,
  toSeries,
  withFtp,
} from '../src/features/activities/analysis';
import { sameRoute, weekStartOf, weekdayOf } from '../src/features/activities/queries';
import { parseDay } from '../src/lib/time';

/** 1 Hz streams: speed (m/s) and optional HR/power/elevation generators per second. */
function synth(
  seconds: number,
  o: {
    speed?: (t: number) => number;
    hr?: (t: number) => number | null;
    power?: (t: number) => number | null;
    ele?: (d: number) => number;
  } = {},
): WorkoutStreams {
  const t: number[] = [];
  const dist: number[] = [];
  const speed: number[] = [];
  const hr: (number | null)[] = [];
  const power: (number | null)[] = [];
  const ele: number[] = [];
  const moving: number[] = [];
  let d = 0;
  for (let i = 0; i <= seconds; i++) {
    const v = o.speed ? o.speed(i) : 3;
    if (i > 0) d += v;
    t.push(i);
    dist.push(d);
    speed.push(v);
    hr.push(o.hr ? o.hr(i) : null);
    power.push(o.power ? o.power(i) : null);
    ele.push(o.ele ? o.ele(d) : 100);
    moving.push(i === 0 ? 0 : 1);
  }
  const s: WorkoutStreams = { t, dist, speed, moving, ele };
  if (o.hr) s.hr = hr;
  if (o.power) s.power = power;
  return s;
}

describe('grade cost factor (Minetti)', () => {
  it('is 1 on the flat and matches the polynomial uphill / downhill', () => {
    expect(gradeCostFactor(0)).toBe(1);
    // C(0.1) = 5.968 J/kg/m vs 3.6 on the flat
    expect(gradeCostFactor(0.1)).toBeCloseTo(5.968 / 3.6, 2);
    // running downhill at −10 % is cheaper than the flat
    expect(gradeCostFactor(-0.1)).toBeCloseTo(2.1517 / 3.6, 2);
    expect(gradeCostFactor(-0.1)).toBeLessThan(1);
    // clamped to ±45 %
    expect(gradeCostFactor(0.9)).toBe(gradeCostFactor(0.45));
    // walking formula is relative to its own flat cost (2.5)
    expect(gradeCostFactor(0, 'walk')).toBe(1);
    expect(gradeCostFactor(0.1, 'hike')).toBeGreaterThan(1.5);
    expect(gradeCostFactor(Number.NaN)).toBe(1);
  });
});

describe('elevation grid & grade adjusted pace', () => {
  it('derives a constant grade and the matching grade adjusted speed', () => {
    const s = toSeries(synth(1200, { ele: (d) => 100 + 0.05 * d }));
    const grid = elevationGrid(s.dist!, s.ele!)!;
    expect(grid).not.toBeNull();
    const mid = grid.grade[Math.floor(grid.grade.length / 2)]!;
    expect(mid).toBeCloseTo(0.05, 3);
    const gap = gradeAdjustedSpeed(s, grid, 'run')!;
    expect(gap).toBeCloseTo(3 * gradeCostFactor(0.05), 1);
    expect(gap).toBeGreaterThan(3);
  });

  it('equals the real speed on the flat', () => {
    const s = toSeries(synth(900));
    const grid = elevationGrid(s.dist!, s.ele!)!;
    expect(gradeAdjustedSpeed(s, grid, 'run')).toBeCloseTo(3, 6);
  });

  it('needs enough distance', () => {
    const s = toSeries(synth(10, { speed: () => 1 }));
    expect(elevationGrid(s.dist!, s.ele!)).toBeNull();
  });
});

describe('aerobic decoupling & efficiency factor', () => {
  it('is ~0 % for a steady effort and 9.1 % when HR drifts 140 → 154 at the same pace', () => {
    const steady = toSeries(synth(3600, { hr: () => 150 }));
    const d0 = aerobicDecoupling(steady, steady.speed, 'pace')!;
    expect(d0.pct).toBeCloseTo(0, 6);
    const drift = toSeries(synth(3600, { hr: (t) => (t < 1800 ? 140 : 154) }));
    const d1 = aerobicDecoupling(drift, drift.speed, 'pace')!;
    expect(d1.first.hr).toBeCloseTo(140, 0);
    expect(d1.second.hr).toBeCloseTo(154, 0);
    expect(d1.pct).toBeCloseTo((1 - 140 / 154) * 100, 0);
  });

  it('needs 20 minutes of moving time and heart rate coverage', () => {
    const short = toSeries(synth(900, { hr: () => 150 }));
    expect(aerobicDecoupling(short, short.speed, 'pace')).toBeNull();
    const sparse = toSeries(synth(3600, { hr: (t) => (t < 600 ? 150 : null) }));
    expect(aerobicDecoupling(sparse, sparse.speed, 'pace')).toBeNull();
  });

  it('efficiency factor = meters per minute per beat', () => {
    const s = toSeries(synth(1800, { hr: () => 150 }));
    expect(efficiencyFactor(s, 3, 'speed')!.value).toBeCloseTo(1.2, 6);
    expect(efficiencyFactor(s, 225, 'power')!.value).toBeCloseTo(1.5, 6);
    expect(efficiencyFactor(toSeries(synth(1800)), 3, 'speed')).toBeNull();
  });
});

describe('power', () => {
  it('normalized power equals average power for a constant effort', () => {
    const s = toSeries(synth(1800, { power: () => 200 }));
    const p = powerPerSecond(s)!;
    expect(normalizedPower(p)).toBeCloseTo(200, 6);
    const a = powerAnalysis(s)!;
    expect(a.avgW).toBeCloseTo(200, 6);
    expect(a.variabilityIndex).toBeCloseTo(1, 6);
    expect(a.peaks.map((x) => x.durationS)).toEqual([5, 60, 300, 1200]);
  });

  it('weights surges: 30 s blocks of 100 / 300 W → NP ≈ 222 W', () => {
    const s = toSeries(synth(3600, { power: (t) => (Math.floor(t / 30) % 2 ? 300 : 100) }));
    const a = powerAnalysis(s)!;
    expect(a.avgW).toBeCloseTo(200, 0);
    expect(a.normalizedW!).toBeGreaterThan(215);
    expect(a.normalizedW!).toBeLessThan(230);
    expect(a.variabilityIndex!).toBeGreaterThan(1.05);
  });

  it('finds peak power windows and adds IF/TSS with an FTP', () => {
    const s = toSeries(synth(3600, { power: (t) => (t >= 1000 && t < 1300 ? 320 : 200) }));
    const p = powerPerSecond(s)!;
    expect(peakPower(p, 300)).toBeCloseTo(320, 6);
    expect(peakPower(p, 5)).toBeCloseTo(320, 6);
    const a = withFtp(powerAnalysis(s)!, 250, 3600);
    expect(a.intensityFactor).toBeCloseTo(a.normalizedW! / 250, 6);
    // 1 h at IF 1.0 would be 100 TSS
    expect(a.tss).toBeCloseTo(100 * a.intensityFactor! ** 2, 3);
    expect(withFtp(a, null, 3600)).toBe(a);
  });

  it('ignores power gaps longer than 10 s', () => {
    const s = toSeries({ t: [0, 1, 2, 60, 61], power: [100, 100, 100, 100, 100], moving: [0, 1, 1, 1, 1] });
    const p = powerPerSecond(s)!;
    expect(p[30]).toBeNaN();
    expect(p[1]).toBe(100);
  });
});

describe('climbs', () => {
  it('detects one climb with its length, gain and grade, ignoring small bumps', () => {
    // flat 500 m, 1000 m at 5 % (+50 m), flat 300 m, descent 40 m over 800 m, 8 m bump, flat
    const profile = (d: number) => {
      if (d < 500) return 200;
      if (d < 1500) return 200 + (d - 500) * 0.05;
      if (d < 1800) return 250;
      if (d < 2600) return 250 - (d - 1800) * 0.05;
      if (d < 2800) return 210 + (d - 2600) * 0.04;
      return 218;
    };
    const s = toSeries(synth(1200, { ele: profile, hr: () => 160 }));
    const grid = elevationGrid(s.dist!, s.ele!)!;
    const climbs = climbsOf(s, grid);
    expect(climbs).toHaveLength(1);
    const c = climbs[0]!;
    expect(c.gainM).toBeGreaterThan(44);
    expect(c.gainM).toBeLessThan(51);
    expect(c.lengthM).toBeGreaterThan(900);
    expect(c.lengthM).toBeLessThan(1100);
    expect(c.avgGrade).toBeCloseTo(0.05, 2);
    expect(c.startDistM).toBeGreaterThan(450);
    expect(c.startDistM).toBeLessThan(600);
    // 3 m/s → 1000 m in ~333 s; VAM = gain per hour
    expect(c.durationS).toBeCloseTo(c.lengthM / 3, 0);
    expect(c.vam).toBeCloseTo(c.gainM / (c.durationS / 3600), 6);
    expect(c.avgHr).toBeCloseTo(160, 6);
    expect(c.category).toBeNull(); // 1000 m × 5 % = 5000 < 8000
  });

  it('splits climbs separated by a real descent and merges across a small dip', () => {
    const step = 10;
    const ele: number[] = [];
    // up 40 m, down 30 m, up 40 m
    for (let i = 0; i <= 80; i++) ele.push(i * 0.5);
    for (let i = 1; i <= 60; i++) ele.push(40 - i * 0.5);
    for (let i = 1; i <= 80; i++) ele.push(10 + i * 0.5);
    expect(detectClimbRanges(Float64Array.from(ele), step)).toHaveLength(2);
    // up 40, dip 3 m, up 40 → one climb
    const merged: number[] = [];
    for (let i = 0; i <= 80; i++) merged.push(i * 0.5);
    for (let i = 1; i <= 6; i++) merged.push(40 - i * 0.5);
    for (let i = 1; i <= 86; i++) merged.push(37 + i * 0.5);
    const r = detectClimbRanges(Float64Array.from(merged), step);
    expect(r).toHaveLength(1);
    expect(merged[r[0]![1]]! - merged[r[0]![0]]!).toBeCloseTo(80, 0);
  });

  it('categorizes by length × grade like Strava', () => {
    expect(climbCategory(1000, 0.05)).toBeNull();
    expect(climbCategory(2000, 0.05)).toBe('4');
    expect(climbCategory(4000, 0.05)).toBe('3');
    expect(climbCategory(8000, 0.05)).toBe('2');
    expect(climbCategory(10000, 0.07)).toBe('1');
    expect(climbCategory(15000, 0.08)).toBe('hc');
  });
});

describe('laps & range stats', () => {
  it('builds swim lengths and sets from events', () => {
    const start = 1_000_000;
    // 4 lengths of 30 s, 20 s rest, 4 lengths
    const events = [] as { type: string; ts: number; durationS: number | null; meta: Record<string, string> | null }[];
    let ts = start;
    for (let set = 0; set < 2; set++) {
      events.push({ type: 'segment', ts, durationS: 120, meta: null });
      for (let l = 0; l < 4; l++) {
        events.push({ type: 'lap', ts, durationS: 30, meta: { HKSwimmingStrokeStyle: set ? '4' : '2' } });
        ts += 30;
      }
      ts += 20;
    }
    const s = toSeries(synth(300, { speed: () => 0.8, hr: () => 140 }));
    const o = { sport: 'swim', startTs: start, endTs: start + 300, lapLengthM: 25 };
    const laps = lapsFromEvents(s, events, 'lap', o);
    expect(laps).toHaveLength(8);
    expect(laps[0]).toMatchObject({ distanceM: 25, durationS: 30, strokeStyle: 'freestyle', lengths: 1 });
    expect(laps[0]!.avgSpeed).toBeCloseTo(25 / 30, 6);
    expect(laps[7]!.strokeStyle).toBe('breaststroke');
    expect(laps[4]!.startT).toBe(140);
    const sets = lapsFromEvents(s, events, 'segment', o);
    expect(sets).toHaveLength(2);
    expect(sets[1]).toMatchObject({ distanceM: 100, lengths: 4, kind: 'segment' });
    expect(sets[0]!.avgHr).toBeCloseTo(140, 6);
  });

  it('uses the stream distance for run laps and falls back to the next event without a duration', () => {
    const start = 2_000_000;
    const s = toSeries(synth(600, { hr: (t) => 120 + t / 10 }));
    const events = [
      { type: 'lap', ts: start, durationS: null, meta: null },
      { type: 'lap', ts: start + 200, durationS: null, meta: null },
    ];
    const laps = lapsFromEvents(s, events, 'lap', { sport: 'run', startTs: start, endTs: start + 600, lapLengthM: null });
    expect(laps.map((l) => l.durationS)).toEqual([200, 400]);
    expect(laps[0]!.distanceM).toBeCloseTo(600, 6);
    expect(laps[1]!.distanceM).toBeCloseTo(1200, 6);
    expect(laps[0]!.avgSpeed).toBeCloseTo(3, 6);
    expect(laps[1]!.maxHr).toBeCloseTo(180, 6);
  });

  it('computes stats between two times', () => {
    const s = toSeries(synth(1000, { hr: () => 150, ele: (d) => 100 + 0.02 * d }));
    const r = statsBetween(s, 100, 400);
    expect(r.distanceM).toBeCloseTo(900, 6);
    expect(r.movingS).toBeCloseTo(300, 6);
    expect(r.avgHr).toBeCloseTo(150, 6);
    expect(r.elevGainM!).toBeGreaterThan(16);
    expect(r.elevGainM!).toBeLessThanOrEqual(18.01);
    expect(timeAtDistance(s, 1500)).toBeCloseTo(500, 6);
    expect(movingSeconds(s)).toBe(1000);
  });
});

describe('analyzeActivity', () => {
  it('handles workouts without streams', () => {
    const a = analyzeActivity({ sport: 'yoga', startTs: 0, endTs: 3600, lapLengthM: null, streams: { t: [] }, events: [] });
    expect(a.hasStreams).toBe(false);
    expect(a.climbs).toEqual([]);
    expect(a.decoupling).toBeNull();
  });

  it('analyses a hilly run end to end', () => {
    const streams = synth(3600, {
      hr: (t) => 140 + t / 360,
      ele: (d) => 150 + 30 * Math.sin(d / 300),
      power: () => 250,
    });
    const a = analyzeActivity({ sport: 'run', startTs: 0, endTs: 3600, lapLengthM: null, streams, events: [] });
    expect(a.hasStreams).toBe(true);
    expect(a.avgSpeed).toBeCloseTo(3, 6);
    expect(a.gapSpeed).not.toBeNull();
    expect(a.efficiency?.basis).toBe('gap');
    expect(a.decoupling?.basis).toBe('pace');
    expect(a.decoupling!.pct).toBeGreaterThan(0);
    expect(a.power?.normalizedW).toBeCloseTo(250, 6);
    expect(a.climbs.length).toBeGreaterThanOrEqual(2);
    expect(a.stoppedS).toBe(0);
  });

  it('uses power for decoupling and efficiency on rides with power', () => {
    const streams = synth(3600, { speed: () => 8, hr: () => 140, power: () => 210 });
    const a = analyzeActivity({ sport: 'ride', startTs: 0, endTs: 3600, lapLengthM: null, streams, events: [] });
    expect(a.decoupling?.basis).toBe('power');
    expect(a.efficiency).toMatchObject({ basis: 'power' });
    expect(a.efficiency!.value).toBeCloseTo(1.5, 6);
    expect(a.gapSpeed).toBeNull();
  });
});

describe('query helpers', () => {
  it('computes weekdays and week starts', () => {
    expect(weekdayOf(parseDay('1970-01-01')!)).toBe(4);
    expect(weekdayOf(parseDay('2026-11-02')!)).toBe(1); // Monday
    expect(weekStartOf('2026-11-04', 1)).toBe('2026-11-02');
    expect(weekStartOf('2026-11-04', 0)).toBe('2026-11-01');
    expect(weekStartOf('2026-11-01', 1)).toBe('2026-10-26');
    expect(weekStartOf('2026-11-01', 0)).toBe('2026-11-01');
  });

  it('matches routes by start, finish and distance', () => {
    const base = {
      id: 1,
      name: '',
      sport: 'run',
      start_ts: 0,
      tz_min: 0,
      distance_m: 10_000,
      moving_s: 3000,
      duration_s: 3000,
      avg_speed: 3.3,
      avg_hr: 150,
      elevation_gain_m: 10,
      effort: 100,
      start_lat: 48.2,
      start_lon: 16.4,
      end_lat: 48.21,
      end_lon: 16.41,
      efficiency: null,
      gap_speed: null,
    };
    expect(sameRoute(base, { ...base, id: 2, start_lat: 48.2005 })).toBe(true);
    expect(sameRoute(base, { ...base, id: 3, start_lat: 48.21 })).toBe(false);
    expect(sameRoute(base, { ...base, id: 4, distance_m: 12_000 })).toBe(false);
    expect(sameRoute(base, { ...base, id: 5, end_lat: null })).toBe(false);
  });
});
