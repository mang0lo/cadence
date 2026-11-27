import { describe, expect, it } from 'vitest';
import { DEFAULT_CONSISTENCY_PREFS, DISTANCE_TOLERANCE, type Goal } from '@cadence/shared';
import { bucketByPeriod, goalHistory, goalProjection, goalReached, type DailyRow } from '../src/features/consistency/goals';
import { goalWithProgress, periodBuckets } from '../src/features/consistency/goals-service';
import { computeScore } from '../src/features/consistency/score';

/**
 * A single-activity distance goal ('longest') is reached with the GPS tolerance of the distance trophies: a 42,150 m
 * run earns the Marathon trophy, so it also reaches a 42,195 m "longest run" goal. Totals keep their exact target.
 */
const row = (day: string, sport: string, o: Partial<DailyRow> = {}): DailyRow => ({
  day,
  sport,
  count: 1,
  durationS: 3600,
  distanceM: 10_000,
  elevationM: 50,
  effort: 50,
  energyKcal: 500,
  ...o,
});

const MARATHON = 42_195;
const goal = (o: Partial<Goal>): Goal => ({
  id: 1,
  position: 0,
  createdAt: 0,
  period: 'year',
  sport: 'run',
  metric: 'longest',
  target: MARATHON,
  ...o,
});

describe('longest goals with the distance tolerance of the trophies', () => {
  it('reaches a single-activity distance like the trophies, totals exactly', () => {
    expect(goalReached('longest', 42_150, MARATHON)).toBe(true);
    expect(goalReached('longest', MARATHON * DISTANCE_TOLERANCE, MARATHON)).toBe(true);
    expect(goalReached('longest', 41_900, MARATHON)).toBe(false);
    expect(goalReached('distance', 9_990, 10_000)).toBe(false);
    expect(goalReached('distance', 10_000, 10_000)).toBe(true);
    expect(goalReached('time', 3599, 3600)).toBe(false);
  });

  it('is done in the current period, with nothing left and the bar full', () => {
    const p = goalProjection({
      value: 42_150,
      target: MARATHON,
      start: '2026-01-01',
      end: '2026-12-31',
      asOf: '2026-11-02',
      single: true,
      metric: 'longest',
    });
    expect(p).toMatchObject({ status: 'done', remaining: 0, fraction: 1 });
    const open = goalProjection({ value: 41_900, target: MARATHON, start: '2026-01-01', end: '2026-12-31', asOf: '2026-11-02', single: true, metric: 'longest' });
    expect(open.status).toBe('open');
    expect(open.remaining).toBeCloseTo(MARATHON - 41_900, 6);
    // a longer run keeps its real share
    const more = goalProjection({ value: 50_000, target: MARATHON, start: '2026-01-01', end: '2026-12-31', asOf: '2026-11-02', single: true, metric: 'longest' });
    expect(more.fraction).toBeCloseTo(50_000 / MARATHON, 9);
    // totals: 9,990 of 10,000 m is not done
    const week = goalProjection({ value: 9_990, target: 10_000, start: '2026-11-02', end: '2026-11-08', asOf: '2026-11-08', metric: 'distance' });
    expect(week.status).not.toBe('done');
  });

  it('counts the past periods and the current one of the goal list', () => {
    const rows = [row('2025-04-27', 'run', { distanceM: 42_150, longestM: 42_150 }), row('2026-10-11', 'run', { distanceM: 42_160, longestM: 42_160 })];
    const g = goal({});
    const history = goalHistory(g, bucketByPeriod(rows, 'year', 1), '2026-11-02', 1, '2025-01-01');
    expect(history).toEqual([{ start: '2025-01-01', end: '2025-12-31', value: 42_150, hit: true }]);
    const withProgress = goalWithProgress(g, rows, periodBuckets(rows, 1), '2026-11-02', 1, '2025-01-01');
    expect(withProgress.current.status).toBe('done');
    expect(withProgress.hitRate).toBe(1);
  });

  it('counts a week as met by a weekly longest goal within the tolerance', () => {
    const rows = [row('2026-10-13', 'run', { distanceM: 21_050, longestM: 21_050 })];
    const s = computeScore({
      rows,
      weeklyGoals: [goal({ period: 'week', target: 21_097.5 })],
      prefs: { ...DEFAULT_CONSISTENCY_PREFS, scoreBasis: 'goals' },
      asOf: '2026-11-02',
      weekStart: 1,
      firstDay: '2026-10-01',
    });
    expect(s.weeks.find((w) => w.weekStart === '2026-10-12')?.met).toBe(true);
  });
});
