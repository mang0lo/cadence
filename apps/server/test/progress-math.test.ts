import { describe, expect, it } from 'vitest';
import type { WorkoutStreams } from '@cadence/shared';
import {
  acwrStatus,
  aerobicDecoupling,
  bandTotals,
  bucketKey,
  bucketsBetween,
  danielsFraction,
  endOfMonth,
  ewma,
  formZone,
  hrSpeedHistogram,
  linearFit,
  median,
  mergeHistograms,
  mostCommonBand,
  rampStatus,
  referenceDayIndex,
  riegel,
  rollingMean,
  rollingMeanBySpan,
  rollingMedian,
  rollingMedianBySpan,
  shiftMonths,
  shiftYears,
  startOfWeek,
  timeFromVdot,
  trainingLoad,
  vdotFromPerformance,
  vo2Level,
  vo2Levels,
  weekdayOf,
} from '../src/features/progress/math';
import { medianWindowFor, trendChange, trendFit } from '../src/features/progress/trends';
import { riegelFromCandidates } from '../src/features/progress/records';
import { comparisonRanges } from '../src/features/progress/volume';
import { parseDay } from '../src/lib/time';

const day = (s: string) => parseDay(s)!;

describe('statistics', () => {
  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('ewma converges to a constant input and starts from the seed', () => {
    const e = ewma(new Array(400).fill(100), 1 / 42);
    expect(e[0]).toBeCloseTo(100 / 42, 10);
    expect(e[41]).toBeCloseTo(100 * (1 - (41 / 42) ** 42), 8);
    expect(e[399]).toBeGreaterThan(99.9);
    expect(ewma([10, 10], 0.5, 10)).toEqual([10, 10]);
  });

  it('trailing rolling mean skips nulls and honours minCount', () => {
    expect(rollingMean([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(rollingMean([1, null, 3, 4], 2, 1)).toEqual([1, 1, 3, 3.5]);
    expect(rollingMean([2, 4], 0)).toEqual([null, null]);
  });

  it('trailing rolling median is robust against a spike', () => {
    expect(rollingMedian([5, 5, 100, 5, 5], 3)).toEqual([5, 5, 5, 5, 5]);
    expect(rollingMedian([1, 2, 3, 4], 2)).toEqual([1, 1.5, 2.5, 3.5]);
  });

  it('span-based trailing mean and median', () => {
    const xs = [0, 1, 2, 10, 11];
    expect(rollingMeanBySpan(xs, [1, 2, 3, 4, 5], 7)).toEqual([1, 1.5, 2, 4, 4.5]);
    expect(rollingMedianBySpan(xs, [1, 9, 3, 4, 5], 3)).toEqual([1, 5, 3, 4, 4.5]);
  });

  it('linear fit recovers slope, intercept and r²', () => {
    const f = linearFit([0, 1, 2, 3], [1, 3, 5, 7])!;
    expect(f.slope).toBeCloseTo(2, 10);
    expect(f.intercept).toBeCloseTo(1, 10);
    expect(f.r2).toBeCloseTo(1, 10);
    expect(linearFit([1, 1], [2, 3])).toBeNull();
    // weights pull the line towards the heavy points
    const w = linearFit([0, 1, 2], [0, 0, 3], [1, 1, 0])!;
    expect(w.slope).toBeCloseTo(0, 10);
    const noisy = linearFit([0, 1, 2, 3], [0, 2, 0, 2])!;
    expect(noisy.r2).toBeGreaterThan(0);
    expect(noisy.r2).toBeLessThan(0.5);
  });
});

describe('trend helpers', () => {
  it('fits over days and reports start/end values', () => {
    const t0 = 1_700_000_000;
    const ts = [0, 10, 20, 30].map((d) => t0 + d * 86400);
    const fit = trendFit(ts, [3, 3.1, 3.2, 3.3])!;
    expect(fit.slopePerDay).toBeCloseTo(0.01, 10);
    expect(fit.startValue).toBeCloseTo(3, 10);
    expect(fit.endValue).toBeCloseTo(3.3, 10);
    expect(trendFit([t0, t0 + 86400, t0 + 2 * 86400], [1, 2, 3])).toBeNull(); // < 14 days
  });

  it('classifies change by direction and kind', () => {
    const fit = { slopePerDay: 0, startTs: 0, endTs: 1, startValue: 200, endValue: 190, r2: 1 };
    expect(trendChange(fit, 'relative', 'down')).toEqual({ change: -0.05, improved: true });
    expect(trendChange(fit, 'relative', 'up').improved).toBe(false);
    expect(trendChange(fit, 'relative', null).improved).toBeNull();
    expect(trendChange({ ...fit, endValue: 199.5 }, 'relative', 'down').improved).toBeNull(); // stable
    expect(trendChange({ ...fit, startValue: 2, endValue: 4 }, 'absolute', 'down')).toEqual({ change: 2, improved: false });
    expect(trendChange(null, 'relative', 'up')).toEqual({ change: null, improved: null });
  });

  it('median window scales with the number of activities', () => {
    expect(medianWindowFor(10)).toBe(5);
    expect(medianWindowFor(90)).toBe(9);
    expect(medianWindowFor(1000)).toBe(15);
  });
});

describe('calendar buckets', () => {
  it('weekday and week start honour weekStart', () => {
    expect(weekdayOf(day('1970-01-01'))).toBe(4); // Thursday
    expect(weekdayOf(day('2026-11-02'))).toBe(1); // Monday
    expect(startOfWeek(day('2026-11-04'), 1)).toBe(day('2026-11-02'));
    expect(startOfWeek(day('2026-11-04'), 0)).toBe(day('2026-11-01'));
    expect(startOfWeek(day('2026-11-01'), 1)).toBe(day('2026-10-26')); // Sunday belongs to the previous Monday week
    expect(startOfWeek(day('2026-11-01'), 0)).toBe(day('2026-11-01'));
  });

  it('bucket keys', () => {
    expect(bucketKey('2026-11-01', 'week', 1)).toBe('2026-10-26');
    expect(bucketKey('2026-11-01', 'week', 0)).toBe('2026-11-01');
    expect(bucketKey('2026-11-01', 'month', 1)).toBe('2026-11');
    expect(bucketKey('2026-11-01', 'year', 1)).toBe('2026');
  });

  it('contiguous buckets over a range', () => {
    const weeks = bucketsBetween('2026-10-01', '2026-10-31', 'week', 1);
    expect(weeks[0]).toEqual({ key: '2026-09-28', fromDay: '2026-09-28', toDay: '2026-10-04' });
    expect(weeks.at(-1)!.key).toBe('2026-10-26');
    expect(weeks).toHaveLength(5);
    const sundays = bucketsBetween('2026-10-01', '2026-10-31', 'week', 0);
    expect(sundays[0]!.key).toBe('2026-09-27');
    const months = bucketsBetween('2023-11-15', '2024-03-02', 'month', 1);
    expect(months.map((m) => m.key)).toEqual(['2023-11', '2023-12', '2024-01', '2024-02', '2024-03']);
    expect(months[3]!.toDay).toBe('2024-02-29');
    expect(bucketsBetween('2024-05-01', '2026-01-01', 'year', 1).map((y) => y.key)).toEqual(['2024', '2025', '2026']);
    expect(bucketsBetween('2026-01-02', '2026-01-01', 'month', 1)).toEqual([]);
  });

  it('reference day index aligns years by calendar date', () => {
    expect(referenceDayIndex('2025-01-01')).toBe(0);
    expect(referenceDayIndex('2024-02-29')).toBe(59);
    expect(referenceDayIndex('2025-03-01')).toBe(60);
    expect(referenceDayIndex('2025-12-31')).toBe(365);
  });

  it('shifting months and years clamps the day', () => {
    expect(shiftMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(shiftMonths('2026-01-15', -1)).toBe('2025-12-15');
    expect(shiftMonths('2025-11-30', 3)).toBe('2026-02-28');
    expect(shiftYears('2024-02-29', -1)).toBe('2023-02-28');
    expect(endOfMonth('2024-02-10')).toBe('2024-02-29');
  });

  it('comparison ranges: running period to date vs the same span before', () => {
    // Wednesday 2026-11-04, Monday weeks
    expect(comparisonRanges('week', 0, '2026-11-04', 1)).toEqual({
      current: ['2026-11-02', '2026-11-04'],
      previous: ['2026-10-26', '2026-10-28'],
      toDate: true,
    });
    expect(comparisonRanges('week', 1, '2026-11-04', 1)).toEqual({
      current: ['2026-10-26', '2026-11-01'],
      previous: ['2026-10-19', '2026-10-25'],
      toDate: false,
    });
    expect(comparisonRanges('month', 0, '2026-03-31', 1)).toEqual({
      current: ['2026-03-01', '2026-03-31'],
      previous: ['2026-02-01', '2026-02-28'],
      toDate: false,
    });
    expect(comparisonRanges('month', 2, '2026-03-10', 1).current).toEqual(['2026-01-01', '2026-01-31']);
    expect(comparisonRanges('year', 0, '2026-11-02', 1)).toEqual({
      current: ['2026-01-01', '2026-11-02'],
      previous: ['2025-01-01', '2025-11-02'],
      toDate: true,
    });
    expect(comparisonRanges('custom', 0, '2026-11-02', 1, { fromDay: '2026-10-06', toDay: '2026-11-02' })).toEqual({
      current: ['2026-10-06', '2026-11-02'],
      previous: ['2026-09-08', '2026-10-05'],
      toDate: false,
    });
  });
});

describe('race prediction', () => {
  it('Riegel', () => {
    expect(riegel(1200, 5000, 5000)).toBe(1200);
    expect(riegel(1200, 5000, 10000)).toBeCloseTo(1200 * 2 ** 1.06, 6);
  });

  it('Daniels/Gilbert VDOT matches the published tables', () => {
    // VDOT 50: 5K 19:57, 10K 41:21, half 1:31:35, marathon 3:10:49
    expect(vdotFromPerformance(5000, 19 * 60 + 57)).toBeCloseTo(50, 0);
    expect(timeFromVdot(50, 5000)!).toBeCloseTo(1197, -1);
    expect(timeFromVdot(50, 10000)!).toBeCloseTo(2481, -1);
    expect(Math.abs(timeFromVdot(50, 21097.5)! - 5495)).toBeLessThan(30);
    expect(Math.abs(timeFromVdot(50, 42195)! - 11449)).toBeLessThan(60);
    expect(timeFromVdot(60, 5000)!).toBeLessThan(timeFromVdot(50, 5000)!);
    expect(timeFromVdot(5, 5000)).toBeNull();
    expect(danielsFraction(0)).toBeCloseTo(1.2884, 3);
  });

  it('picks the closest recent effort (log distance, ties → longer)', () => {
    const ref = (elapsedS: number) => ({ workoutId: 1, name: '', sport: 'run', startTs: 0, tzMin: 0, elapsedS });
    const c = [
      { effort: '5k', distanceM: 5000, row: ref(1500) },
      { effort: '10k', distanceM: 10000, row: ref(3200) },
      { effort: '20k', distanceM: 20000, row: ref(6800) },
    ];
    expect(riegelFromCandidates(c, 10000)!.basis.effort).toBe('10k');
    expect(riegelFromCandidates(c, 42195)!.basis.effort).toBe('20k');
    // 7071 m is equally far from 5k and 10k on a log scale → the longer effort wins
    expect(riegelFromCandidates(c, Math.sqrt(5000 * 10000))!.basis.effort).toBe('10k');
    expect(riegelFromCandidates([], 5000)).toBeNull();
  });
});

describe('training load', () => {
  it('fitness, fatigue, form, ramp and ACWR', () => {
    const loads = [...new Array(60).fill(100), ...new Array(14).fill(0)];
    const m = trainingLoad(loads);
    const d59 = m[59]!;
    expect(d59.ctl).toBeCloseTo(100 * (1 - (41 / 42) ** 60), 6);
    expect(d59.atl).toBeCloseTo(100 * (1 - (6 / 7) ** 60), 6);
    expect(d59.tsb).toBeCloseTo(d59.ctl - d59.atl, 10);
    expect(d59.ramp).toBeCloseTo(m[59]!.ctl - m[52]!.ctl, 10);
    expect(d59.acwr).toBeCloseTo(1, 10);
    // after two weeks off fatigue drops faster than fitness → fresh
    const last = m.at(-1)!;
    expect(last.tsb).toBeGreaterThan(20);
    expect(last.acwr).toBe(0);
    expect(trainingLoad([0, 0, 0])[2]!.acwr).toBeNull();
  });

  it('form zones, ramp and ACWR status', () => {
    expect(formZone(30)).toBe('transition');
    expect(formZone(25)).toBe('transition');
    expect(formZone(10)).toBe('fresh');
    expect(formZone(0)).toBe('optimal');
    expect(formZone(-10)).toBe('optimal'); // lower bounds are inclusive
    expect(formZone(-10.1)).toBe('tired');
    expect(formZone(-29.9)).toBe('tired');
    expect(formZone(-30.1)).toBe('overreaching');
    expect(rampStatus(3)).toBe('normal');
    expect(rampStatus(6)).toBe('elevated');
    expect(rampStatus(9)).toBe('high');
    expect(acwrStatus(null)).toBeNull();
    expect(acwrStatus(0.5)).toBe('low');
    expect(acwrStatus(1.1)).toBe('optimal');
    expect(acwrStatus(1.4)).toBe('elevated');
    expect(acwrStatus(1.8)).toBe('high');
  });
});

describe('VO2max levels', () => {
  it('bands depend on age and sex', () => {
    const m38 = vo2Levels(38, 'male')!;
    expect(m38.map((l) => l.key)).toEqual(['poor', 'fair', 'good', 'excellent', 'superior']);
    expect(m38[0]).toEqual({ key: 'poor', min: null, max: 36.7 });
    expect(m38[4]!.max).toBeNull();
    expect(vo2Level(50.8, m38)).toBe('superior');
    expect(vo2Level(42, m38)).toBe('good');
    expect(vo2Level(30, m38)).toBe('poor');
    const f38 = vo2Levels(38, 'female')!;
    expect(vo2Level(42, f38)).toBe('superior');
    const other = vo2Levels(38, null)!;
    expect(other[1]!.min!).toBeGreaterThan(f38[1]!.min!);
    expect(other[1]!.min!).toBeLessThan(m38[1]!.min!);
    expect(vo2Levels(null, 'male')).toBeNull();
    expect(vo2Levels(75, 'male')![1]!.min).toBe(24.9);
  });
});

describe('pace at heart rate', () => {
  /** 1 Hz stream: `n` seconds at constant speed `v`, heart rate from `hr(i)`. */
  function stream(n: number, v: number | ((i: number) => number), hr: (i: number) => number | null): WorkoutStreams {
    const t: number[] = [];
    const dist: number[] = [];
    const speed: number[] = [];
    const h: (number | null)[] = [];
    const moving: number[] = [];
    let d = 0;
    for (let i = 0; i < n; i++) {
      const s = typeof v === 'number' ? v : v(i);
      if (i) d += s;
      t.push(i);
      dist.push(d);
      speed.push(s);
      h.push(hr(i));
      moving.push(i ? 1 : 0);
    }
    return { t, dist, speed, hr: h, moving };
  }
  const filter = { skipS: 300, minSpeed: 0.8, maxSpeed: 12 };

  it('accumulates moving time and distance per bpm after the warm-up', () => {
    const st = stream(1501, 3, (i) => (i < 900 ? 140 : 150));
    const h = hrSpeedHistogram(st, filter)!;
    expect(h.lo).toBe(140);
    expect(h.s).toHaveLength(11);
    expect(h.s[0]).toBeCloseTo(600, 6); // seconds 300..899 (warm-up skipped)
    expect(h.s[10]).toBeCloseTo(601, 6);
    expect(h.d[0]).toBeCloseTo(1800, 6);
    const band = bandTotals(h, 140, 150);
    expect(band.seconds).toBeCloseTo(600, 6);
    expect(band.meters / band.seconds).toBeCloseTo(3, 6);
    expect(bandTotals(h, 145, 160).seconds).toBeCloseTo(601, 6);
    expect(bandTotals(h, 100, 120).seconds).toBe(0);
  });

  it('ignores stops, missing heart rate and implausible speed', () => {
    const st = stream(1000, (i) => (i % 100 < 10 ? 0.2 : i % 100 < 20 ? 30 : 3), (i) => (i % 2 ? 145 : null));
    const h = hrSpeedHistogram(st, filter)!;
    const b = bandTotals(h, 140, 150);
    // only odd seconds (hr) with speed 3 after 300 s: 700 s * 80 % / 2
    expect(b.seconds).toBeCloseTo(280, 6);
    expect(b.meters / b.seconds).toBeCloseTo(3, 6);
    expect(hrSpeedHistogram({ t: [0, 1], dist: [0, 3] }, filter)).toBeNull();
  });

  it('merges histograms and finds the most common 10 bpm band', () => {
    const a = { lo: 140, s: [10, 10, 100], d: [0, 0, 0] };
    const b = { lo: 141, s: [5, 200], d: [0, 0] };
    const m = mergeHistograms([a, b])!;
    expect(m).toEqual({ lo: 140, seconds: [10, 15, 300] });
    expect(mostCommonBand({ lo: 130, seconds: new Array(30).fill(1).map((x, i) => (i >= 12 && i < 20 ? 100 : x)) })).toEqual({
      lo: 140,
      hi: 150,
    });
    expect(mostCommonBand({ lo: 100, seconds: [0, 0] })).toBeNull();
    expect(mergeHistograms([])).toBeNull();
  });

  it('aerobic decoupling compares speed per heartbeat of both halves', () => {
    // same speed, heart rate drifts from 140 to 154 in the second half → (1 − 140/154) ≈ 9.1 %
    const st = stream(3301, 3, (i) => (i < 1800 ? 140 : 154));
    expect(aerobicDecoupling(st, filter)!).toBeCloseTo((1 - 140 / 154) * 100, 1);
    // steady → ~0
    expect(Math.abs(aerobicDecoupling(stream(3301, 3, () => 140), filter)!)).toBeLessThan(1e-9);
    // too short
    expect(aerobicDecoupling(stream(1200, 3, () => 140), filter)).toBeNull();
  });
});
