import { describe, expect, it } from 'vitest';
import {
  periodRange,
  weekStartOf,
  weekdayOf,
  monthEndOf,
  localParts,
  previousPeriodStart,
} from '../src/features/consistency/days';
import {
  dailyStreak,
  dayRuns,
  firstDayReaching,
  longestRunWithin,
  longestWeekRunWithin,
  weekRuns,
  weeklyStreak,
} from '../src/features/consistency/streaks';

describe('day helpers', () => {
  it('computes weekdays, week starts and period ranges', () => {
    expect(weekdayOf('2026-11-02')).toBe(1); // Monday
    expect(weekdayOf('2026-11-01')).toBe(0); // Sunday
    expect(weekStartOf('2026-11-01', 1)).toBe('2026-10-26');
    expect(weekStartOf('2026-11-01', 0)).toBe('2026-11-01');
    expect(weekStartOf('2026-11-07', 0)).toBe('2026-11-01');
    expect(periodRange('2026-11-04', 'week', 1)).toEqual({ start: '2026-11-02', end: '2026-11-08' });
    expect(periodRange('2024-02-10', 'month', 1)).toEqual({ start: '2024-02-01', end: '2024-02-29' });
    expect(periodRange('2025-02-10', 'month', 1)).toEqual({ start: '2025-02-01', end: '2025-02-28' });
    expect(periodRange('2026-12-31', 'year', 1)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(monthEndOf('2026-12-05')).toBe('2026-12-31');
    expect(previousPeriodStart('2026-01-01', 'month')).toBe('2025-12-01');
    expect(previousPeriodStart('2026-03-01', 'month')).toBe('2026-02-01');
    expect(previousPeriodStart('2026-11-02', 'week')).toBe('2026-10-26');
    expect(previousPeriodStart('2026-01-01', 'year')).toBe('2025-01-01');
  });

  it('reads local wall-clock parts of a timestamp', () => {
    // 2026-11-01 23:30 UTC = 2026-11-02 00:30 in UTC+1 (a Monday)
    const ts = Date.UTC(2026, 10, 1, 23, 30) / 1000;
    expect(localParts(ts, 60)).toEqual({ day: '2026-11-02', weekday: 1, hour: 0 });
    expect(localParts(ts, -240)).toEqual({ day: '2026-11-01', weekday: 0, hour: 19 });
  });
});

describe('daily streaks', () => {
  it('handles no data', () => {
    expect(dailyStreak([], '2026-11-02')).toEqual({
      current: 0,
      currentStart: null,
      longest: 0,
      longestStart: null,
      longestEnd: null,
      pending: false,
    });
  });

  it('counts a streak that includes today', () => {
    const s = dailyStreak(['2026-10-31', '2026-11-01', '2026-11-02'], '2026-11-02');
    expect(s).toMatchObject({ current: 3, currentStart: '2026-10-31', longest: 3, pending: false });
  });

  it('keeps the streak alive while today is not active yet', () => {
    const s = dailyStreak(['2026-10-31', '2026-11-01'], '2026-11-02');
    expect(s).toMatchObject({ current: 2, currentStart: '2026-10-31', pending: true });
  });

  it('breaks on a missed day', () => {
    const s = dailyStreak(['2026-10-29', '2026-10-30', '2026-10-31'], '2026-11-02');
    expect(s).toMatchObject({ current: 0, currentStart: null, longest: 3, pending: false });
    expect(s.longestStart).toBe('2026-10-29');
    expect(s.longestEnd).toBe('2026-10-31');
  });

  it('ignores duplicates, order and days after asOf; prefers the most recent longest run', () => {
    const days = ['2026-03-02', '2026-01-01', '2026-03-01', '2026-01-02', '2026-01-02', '2026-03-05'];
    const s = dailyStreak(days, '2026-03-04');
    expect(s.longest).toBe(2);
    expect(s.longestStart).toBe('2026-03-01');
    expect(s.current).toBe(0);
  });

  it('crosses month ends and leap days', () => {
    const s = dailyStreak(['2024-02-28', '2024-02-29', '2024-03-01'], '2024-03-01');
    expect(s.current).toBe(3);
  });

  it('lists runs and the day a run first reached a length', () => {
    const runs = dayRuns(['2026-01-01', '2026-01-02', '2026-01-04', '2026-01-05', '2026-01-06']);
    expect(runs).toEqual([
      { start: '2026-01-01', end: '2026-01-02', length: 2 },
      { start: '2026-01-04', end: '2026-01-06', length: 3 },
    ]);
    expect(firstDayReaching(runs, 2)).toBe('2026-01-02');
    expect(firstDayReaching(runs, 3)).toBe('2026-01-06');
    expect(firstDayReaching(runs, 4)).toBeNull();
  });

  it('finds the longest run inside a range', () => {
    const days = ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-02-01'];
    expect(longestRunWithin(days, '2026-01-01', '2026-12-31')).toEqual({
      start: '2026-01-01',
      end: '2026-01-02',
      length: 2,
    });
    expect(longestRunWithin([], '2026-01-01', '2026-12-31')).toBeNull();
  });
});

describe('weekly streaks', () => {
  // 2026-11-04 is a Wednesday
  it('counts consecutive weeks including the current one', () => {
    const s = weeklyStreak(['2026-10-20', '2026-10-27', '2026-11-03'], '2026-11-04', 1);
    expect(s).toMatchObject({ current: 3, currentStart: '2026-10-19', pending: false, thisWeek: 1, longest: 3 });
  });

  it('keeps the streak while the current week has no activity yet', () => {
    const s = weeklyStreak(['2026-10-20', '2026-10-27'], '2026-11-04', 1);
    expect(s).toMatchObject({ current: 2, pending: true, thisWeek: 0 });
  });

  it('breaks after a week without activity', () => {
    const s = weeklyStreak(['2026-10-13', '2026-10-20'], '2026-11-04', 1);
    expect(s).toMatchObject({ current: 0, longest: 2, longestStart: '2026-10-12', longestEnd: '2026-10-25' });
  });

  it('respects the week start', () => {
    // Monday 26 Oct and Sunday 8 Nov: consecutive Monday-weeks, but Sunday-weeks 25 Oct and 8 Nov leave a gap
    const days = ['2026-10-26', '2026-11-08'];
    expect(weeklyStreak(days, '2026-11-08', 1).current).toBe(2);
    const sunday = weeklyStreak(days, '2026-11-08', 0);
    expect(sunday.current).toBe(1);
    expect(sunday.longest).toBe(1);
  });

  it('supports a minimum of active days per week', () => {
    const days = ['2026-10-19', '2026-10-21', '2026-10-26', '2026-10-28', '2026-10-30'];
    const s = weeklyStreak(days, '2026-11-04', 1, 2);
    expect(s).toMatchObject({ current: 2, pending: true, minPerWeek: 2 });
    expect(weeklyStreak(days, '2026-11-04', 1, 3)).toMatchObject({ current: 1, pending: true, longest: 1 });
  });

  it('clamps the end of a running longest streak to asOf', () => {
    const s = weeklyStreak(['2026-10-27', '2026-11-03'], '2026-11-04', 1);
    expect(s.longestEnd).toBe('2026-11-04');
  });

  it('lists week runs and the longest run of weeks inside a range', () => {
    const days = ['2025-12-22', '2025-12-29', '2026-01-05', '2026-01-19'];
    expect(weekRuns(days, 1)).toEqual([
      { start: '2025-12-22', end: '2026-01-05', length: 3 },
      { start: '2026-01-19', end: '2026-01-19', length: 1 },
    ]);
    // only days inside the range count; the run is clamped to the range
    const inYear = longestWeekRunWithin([...days, '2026-01-02'], '2026-01-01', '2026-12-31', 1);
    expect(inYear).toEqual({ start: '2026-01-01', end: '2026-01-11', length: 2 });
    expect(longestWeekRunWithin(days, '2026-01-01', '2026-12-31', 1)).toEqual({
      start: '2026-01-19',
      end: '2026-01-25',
      length: 1,
    });
  });
});
