/**
 * Values of the route / segment effort trend (apps/web/src/features/maps/lib/effortTrend.ts): pace per 100 m for
 * swims, per km / mi for runs, speed for rides, with units in tooltip and table.
 */
import { describe, expect, it } from 'vitest';
import { effortScale, effortSeries, type TrendEffort } from '@/features/maps/lib/effortTrend';
import { createFormatter } from '@/lib/format';

const metric = createFormatter('metric', 'en-US', 'en');
const imperial = createFormatter('imperial', 'en-US', 'en');

const effort = (day: number, timeS: number, avgSpeed: number | null): TrendEffort => ({
  startTs: 1_750_000_000 + day * 86_400,
  tzMin: 120,
  timeS,
  avgSpeed,
  avgHr: null,
  rank: 1,
});

describe('effort trend pace and speed', () => {
  it('shows swim pace per 100 m (2:05 /100m, not 20:50 per km)', () => {
    const s = effortScale(metric, 'swim', 'pace');
    const v = s.value(effort(0, 1500, 0.8))!;
    expect(v).toBeCloseTo(125, 6);
    expect(s.axisLabel(v)).toBe('2:05');
    expect(s.label(v)).toBe('2:05 /100m');
    expect(s.lowerIsBetter).toBe(true);
  });

  it('shows swim pace per 100 yd in imperial units', () => {
    const s = effortScale(imperial, 'swim', 'pace');
    const v = s.value(effort(0, 1500, 0.8))!;
    expect(v).toBeCloseTo(91.44 / 0.8, 6);
    expect(s.label(v)).toBe('1:54 /100yd');
  });

  it('shows run pace per km / mi and ride speed in km/h', () => {
    const run = effortScale(metric, 'run', 'pace');
    expect(run.label(run.value(effort(0, 1800, 1000 / 300))!)).toBe('5:00 /km');
    const runMi = effortScale(imperial, 'run', 'pace');
    expect(runMi.label(runMi.value(effort(0, 1800, 1609.344 / 480))!)).toBe('8:00 /mi');
    const ride = effortScale(metric, 'ride', 'pace');
    expect(ride.label(ride.value(effort(0, 1800, 25 / 3.6))!)).toBe('25.0 km/h');
    expect(ride.lowerIsBetter).toBe(false);
  });

  it('has no value for an effort without speed', () => {
    const s = effortScale(metric, 'run', 'pace');
    expect(s.value(effort(0, 1800, null))).toBeNull();
    expect(s.value(effort(0, 1800, 0))).toBeNull();
  });

  it('keeps the running best: lowest time or pace, highest speed', () => {
    const efforts = [effort(0, 1900, 0.8), effort(1, 1800, 0.9), effort(2, 2000, null), effort(3, 1850, 0.85)];
    const time = effortSeries(efforts, effortScale(metric, 'swim', 'time'));
    expect(time.bestSoFar.map((p) => p[1])).toEqual([1900, 1800, 1800, 1800]);
    const pace = effortSeries(efforts, effortScale(metric, 'swim', 'pace'));
    expect(pace.points[2]![1]).toBeNull();
    expect(pace.bestSoFar.map((p) => Math.round(p[1]))).toEqual([125, 111, 111]);
    const speed = effortSeries(efforts, effortScale(metric, 'ride', 'pace'));
    expect(speed.bestSoFar.map((p) => +p[1].toFixed(2))).toEqual([2.88, 3.24, 3.24]);
  });
});
