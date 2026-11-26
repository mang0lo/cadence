import { describe, expect, it } from 'vitest';
import type { MetricPoint, MetricSeries } from '@cadence/shared';
import { fillPeriods, periodKeys, periodStart, seriesKeys } from '@/features/health/lib/periods';

const pt = (key: string, value: number, days = 1): MetricPoint => ({ key, value, min: null, max: null, n: 1, days });

type Series = Pick<MetricSeries, 'agg' | 'fromDay' | 'toDay' | 'points' | 'categories'>;

describe('health period keys', () => {
  it('finds the start of a day, week and month', () => {
    expect(periodStart('2025-12-03', 'day', 1)).toBe('2025-12-03');
    expect(periodStart('2025-12-03', 'week', 1)).toBe('2025-12-01'); // a Wednesday; weeks start on Monday
    expect(periodStart('2025-12-03', 'week', 0)).toBe('2025-11-30'); // … or on Sunday
    expect(periodStart('2025-12-31', 'month', 1)).toBe('2025-12-01');
  });

  it('lists every period of a range, across month and year ends', () => {
    expect(periodKeys('2025-12-30', '2026-01-02', 'day', 1)).toEqual(['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']);
    expect(periodKeys('2025-12-03', '2025-12-24', 'week', 1)).toEqual(['2025-12-01', '2025-12-08', '2025-12-15', '2025-12-22']);
    expect(periodKeys('2025-10-15', '2026-02-01', 'month', 1)).toEqual(['2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01']);
    expect(periodKeys('2025-08-31', '2025-10-01', 'month', 1)).toEqual(['2025-08-01', '2025-09-01', '2025-10-01']);
    expect(periodKeys('2026-01-02', '2025-12-30', 'day', 1)).toEqual([]);
  });

  it('keeps weeks without data between sparse weeks (swimming: Dec 1, then Dec 22)', () => {
    const series: Series = {
      agg: 'week',
      fromDay: '2025-11-26',
      toDay: '2025-12-28',
      points: [pt('2025-12-01', 1500), pt('2025-12-22', 2000)],
      categories: [],
    };
    const keys = seriesKeys(series, 1);
    expect(keys).toEqual(['2025-11-24', '2025-12-01', '2025-12-08', '2025-12-15', '2025-12-22']);
    const filled = fillPeriods(series.points, keys);
    expect(filled.map((p) => p.value)).toEqual([0, 1500, 0, 0, 2000]);
    expect(filled[2]).toEqual({ key: '2025-12-08', value: 0, min: null, max: null, n: 0, days: 0 });
  });

  it('follows the week start of the data and keeps keys of category values', () => {
    // the series was built with Sunday weeks although the setting says Monday
    const series: Series = {
      agg: 'week',
      fromDay: '2025-11-30',
      toDay: '2025-12-20',
      points: [pt('2025-11-30', 10)],
      categories: [{ value: 'InBed', total: 5, points: [pt('2025-12-14', 5)] }],
    };
    expect(seriesKeys(series, 1)).toEqual(['2025-11-30', '2025-12-07', '2025-12-14']);
  });

  it('spans the points when the range is open', () => {
    const series: Series = { agg: 'day', fromDay: null, toDay: null, points: [pt('2025-12-01', 1), pt('2025-12-04', 2)], categories: [] };
    expect(seriesKeys(series, 1)).toEqual(['2025-12-01', '2025-12-02', '2025-12-03', '2025-12-04']);
    expect(seriesKeys({ ...series, points: [] }, 1)).toEqual([]);
  });
});
