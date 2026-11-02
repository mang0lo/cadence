import { describe, expect, it } from 'vitest';
import { DEFAULT_CONSISTENCY_PREFS } from '@cadence/shared';
import { plusDays } from '../src/features/consistency/days';
import {
  bucketByPeriod,
  defaultGoals,
  goalHistory,
  goalProjection,
  goalValue,
  isFeasible,
  niceTarget,
  roundNice,
  suggestGoals,
  topDistanceSport,
  type DailyRow,
} from '../src/features/consistency/goals';
import { computeScore } from '../src/features/consistency/score';

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

describe('goal values', () => {
  const rows = [
    row('2026-11-02', 'run'),
    row('2026-11-02', 'ride', { distanceM: 30_000 }),
    row('2026-11-03', 'strength', { distanceM: 0, elevationM: 0 }),
    row('2026-11-04', 'run', { count: 0 }),
  ];
  it('sums per metric and filters by sport', () => {
    expect(goalValue(rows, 'distance', null)).toBe(40_000);
    expect(goalValue(rows, 'distance', 'run')).toBe(10_000);
    expect(goalValue(rows, 'time', null)).toBe(3 * 3600);
    expect(goalValue(rows, 'elevation', null)).toBe(100);
    expect(goalValue(rows, 'activities', null)).toBe(3);
    // distinct days; rows without activities do not count
    expect(goalValue(rows, 'active_days', null)).toBe(2);
    expect(goalValue(rows, 'active_days', 'strength')).toBe(1);
  });
});

describe('goal projection', () => {
  const week = { start: '2026-11-02', end: '2026-11-08', target: 70_000 };

  it('is on track on the first day without activity', () => {
    const p = goalProjection({ ...week, value: 0, asOf: '2026-11-02' });
    expect(p).toMatchObject({ elapsedDays: 0, totalDays: 7, expected: 0, projected: 0, status: 'on_track', remainingDays: 7 });
    expect(p.perDayNeeded).toBe(10_000);
  });

  it('compares with the pro-rata expectation at the start of today', () => {
    // Thursday: 3 days elapsed → 30 km expected
    const behind = goalProjection({ ...week, value: 20_000, asOf: '2026-11-05' });
    expect(behind.status).toBe('behind');
    expect(behind.expected).toBeCloseTo(30_000);
    expect(behind.projected).toBeCloseTo(35_000); // 20 km over 4 days incl. today
    expect(behind.remainingDays).toBe(4);
    expect(behind.perDayNeeded).toBeCloseTo(12_500);
    expect(goalProjection({ ...week, value: 30_000, asOf: '2026-11-05' }).status).toBe('on_track');
  });

  it('is done when the target is reached', () => {
    const p = goalProjection({ ...week, value: 75_000, asOf: '2026-11-05' });
    expect(p).toMatchObject({ status: 'done', remaining: 0, perDayNeeded: null });
    expect(p.fraction).toBeCloseTo(75 / 70);
  });

  it('handles the last day of the period', () => {
    // 60 km by Sunday morning is exactly on pace
    expect(goalProjection({ ...week, value: 60_000, asOf: '2026-11-08' }).status).toBe('on_track');
    const p = goalProjection({ ...week, value: 50_000, asOf: '2026-11-08' });
    expect(p).toMatchObject({ elapsedDays: 6, remainingDays: 1, status: 'behind' });
    expect(p.projected).toBeCloseTo(50_000);
    expect(p.perDayNeeded).toBeCloseTo(20_000);
  });
});

describe('goal history', () => {
  it('lists completed periods back to the first data', () => {
    const rows = [row('2026-10-05', 'run'), row('2026-10-13', 'run'), row('2026-10-14', 'run'), row('2026-10-27', 'run')];
    const buckets = bucketByPeriod(rows, 'week', 1);
    const goal = { period: 'week' as const, sport: null, metric: 'active_days' as const, target: 2 };
    const h = goalHistory(goal, buckets, '2026-11-04', 1, '2026-10-05');
    expect(h.map((x) => [x.start, x.value, x.hit])).toEqual([
      ['2026-10-05', 1, false],
      ['2026-10-12', 2, true],
      ['2026-10-19', 0, false],
      ['2026-10-26', 1, false],
    ]);
    expect(goalHistory(goal, buckets, '2026-11-04', 1, null)).toEqual([]);
    expect(goalHistory(goal, buckets, '2026-11-04', 1, '2020-01-01')).toHaveLength(12);
  });
});

describe('nice targets and suggestions', () => {
  it('rounds to numbers people pick as goals', () => {
    expect(roundNice(27)).toBe(25);
    expect(roundNice(2.4)).toBe(2.5);
    expect(roundNice(120)).toBe(125);
    expect(roundNice(8.3)).toBe(8);
    expect(roundNice(48)).toBe(50);
    expect(roundNice(1500)).toBe(1500);
    expect(roundNice(0)).toBe(0);
  });

  it('builds targets per metric', () => {
    expect(niceTarget('active_days', 'week', 4.6)).toBe(5);
    expect(niceTarget('active_days', 'week', 9)).toBe(7);
    expect(niceTarget('active_days', 'year', 249)).toBe(275);
    expect(niceTarget('time', 'week', 342 * 60, 1)).toBe(6 * 3600);
    expect(niceTarget('time', 'week', 75 * 60, 1)).toBe(80 * 60);
    expect(niceTarget('distance', 'month', 118_000, 1)).toBe(125_000);
    expect(niceTarget('elevation', 'month', 30, 1)).toBe(100);
  });

  it('checks feasibility', () => {
    expect(isFeasible({ period: 'week', sport: null, metric: 'active_days', target: 7 })).toBe(true);
    expect(isFeasible({ period: 'week', sport: null, metric: 'active_days', target: 8 })).toBe(false);
    expect(isFeasible({ period: 'year', sport: 'run', metric: 'distance', target: 0 })).toBe(false);
  });

  // 10 weeks: run Mon + Wed (10 km each), ride Sat (40 km)
  const rows: DailyRow[] = [];
  for (let w = 0; w < 10; w++) {
    const monday = plusDays('2026-08-24', w * 7);
    rows.push(row(monday, 'run'), row(plusDays(monday, 2), 'run'), row(plusDays(monday, 5), 'ride', { distanceM: 40_000 }));
  }
  const asOf = '2026-11-04';

  it('picks the distance sport with the most distance', () => {
    expect(topDistanceSport(rows)).toBe('ride');
    expect(topDistanceSport([row('2026-01-01', 'strength', { distanceM: 0 })])).toBeNull();
  });

  it('suggests goals from recent averages and skips existing ones', () => {
    const s = suggestGoals(rows, [{ period: 'week', metric: 'time', sport: null }], asOf, 1, '2026-08-24');
    const days = s.find((x) => x.period === 'week' && x.metric === 'active_days')!;
    expect(days.average).toBeCloseTo(3);
    expect(days.target).toBe(3);
    expect(days.periods).toBe(8);
    expect(s.some((x) => x.period === 'week' && x.metric === 'time')).toBe(false);
    const ride = s.find((x) => x.period === 'week' && x.metric === 'distance')!;
    expect(ride.sport).toBe('ride');
    expect(ride.target).toBe(45_000);
    expect(suggestGoals([], [], asOf, 1, null)).toEqual([]);
  });

  it('creates default goals', () => {
    const d = defaultGoals(rows, asOf, 1, '2026-08-24');
    expect(d[0]).toEqual({ period: 'week', sport: null, metric: 'active_days', target: 3 });
    expect(d[1]).toMatchObject({ period: 'week', metric: 'time', target: 3 * 3600 });
    expect(d[2]).toMatchObject({ period: 'month', sport: 'ride', metric: 'distance' });
    // without history: WHO baseline
    const empty = defaultGoals([], asOf, 1, '2026-11-01');
    expect(empty).toEqual([
      { period: 'week', sport: null, metric: 'active_days', target: 3 },
      { period: 'week', sport: null, metric: 'time', target: 150 * 60 },
    ]);
  });
});

describe('consistency score', () => {
  // 14 weeks with 3 active days each, except two weeks with 1 day
  const rows: DailyRow[] = [];
  const firstMonday = '2026-07-27';
  for (let w = 0; w < 14; w++) {
    const monday = plusDays(firstMonday, w * 7);
    const n = w === 5 || w === 9 ? 1 : 3;
    for (let i = 0; i < n; i++) rows.push(row(plusDays(monday, i * 2), 'run', { durationS: 1800 }));
  }
  const asOf = '2026-11-04'; // week 14 (in progress) starts 2026-11-02

  it('scores the last 12 complete weeks', () => {
    const s = computeScore({ rows, weeklyGoals: [], prefs: DEFAULT_CONSISTENCY_PREFS, asOf, weekStart: 1, firstDay: firstMonday });
    expect(s.basis).toBe('days');
    expect(s.total).toBe(12);
    expect(s.met).toBe(10);
    expect(s.score).toBeCloseTo(10 / 12);
    expect(s.weeks).toHaveLength(13);
    expect(s.weeks[12]).toMatchObject({ weekStart: '2026-11-02', inProgress: true });
    expect(s.trend).toHaveLength(52);
    expect(s.trend[51]!.score).toBeCloseTo(10 / 12);
    // weeks before the first data have no score
    expect(s.trend[0]!.score).toBeNull();
  });

  it('only counts weeks since the first data', () => {
    const s = computeScore({ rows, weeklyGoals: [], prefs: DEFAULT_CONSISTENCY_PREFS, asOf, weekStart: 1, firstDay: '2026-10-12' });
    expect(s.total).toBe(3);
    expect(s.score).toBe(1);
    expect(computeScore({ rows: [], weeklyGoals: [], prefs: DEFAULT_CONSISTENCY_PREFS, asOf, weekStart: 1, firstDay: null }).score).toBeNull();
  });

  it('can use weekly goals as the basis', () => {
    const weeklyGoals = [{ period: 'week' as const, sport: null, metric: 'time' as const, target: 2 * 3600 }];
    const s = computeScore({ rows, weeklyGoals, prefs: { scoreBasis: 'goals', minActiveDays: 3 }, asOf, weekStart: 1, firstDay: firstMonday });
    expect(s.basis).toBe('goals');
    expect(s.weeklyGoals).toBe(1);
    expect(s.met).toBe(0); // 3 × 30 min < 2 h
    // falls back to active days without weekly goals
    const fallback = computeScore({ rows, weeklyGoals: [], prefs: { scoreBasis: 'goals', minActiveDays: 1 }, asOf, weekStart: 1, firstDay: firstMonday });
    expect(fallback).toMatchObject({ basis: 'days', met: 12 });
  });
});

describe('single-activity goals (longest)', () => {
  const rows = [
    row('2026-03-01', 'run', { longestM: 21_097.5, distanceM: 21_097.5 }),
    row('2026-05-10', 'run', { longestM: 30_000, distanceM: 38_000, count: 2 }),
    row('2026-06-01', 'ride', { longestM: 120_000, distanceM: 120_000 }),
  ];

  it('takes the longest single activity, not the sum', () => {
    expect(goalValue(rows, 'longest', 'run')).toBe(30_000);
    expect(goalValue(rows, 'longest', null)).toBe(120_000);
    expect(goalValue(rows, 'distance', 'run')).toBeCloseTo(59_097.5, 6);
  });

  it('is open until reached: no pace, no per-day need', () => {
    const open = goalProjection({ value: 30_000, target: 42_195, start: '2026-01-01', end: '2026-12-31', asOf: '2026-11-02', single: true });
    expect(open.status).toBe('open');
    expect(open.expected).toBe(0);
    expect(open.perDayNeeded).toBeNull();
    expect(open.remaining).toBeCloseTo(12_195, 6);
    const done = goalProjection({ value: 42_300, target: 42_195, start: '2026-01-01', end: '2026-12-31', asOf: '2026-11-02', single: true });
    expect(done.status).toBe('done');
  });

  it('suggests the next classic distance above the longest of the last year', () => {
    const recent = [
      ...Array.from({ length: 30 }, (_, i) => row(plusDays('2026-10-31', -7 * i), 'run', { distanceM: 12_000, longestM: 12_000 })),
      row('2026-09-20', 'run', { distanceM: 25_000, longestM: 25_000 }),
    ];
    const s = suggestGoals(recent, [], '2026-11-02', 1, '2026-01-01', 10);
    const longest = s.find((g) => g.metric === 'longest');
    expect(longest).toMatchObject({ period: 'year', sport: 'run', target: 42_195, average: 25_000 });
    // not suggested again when such a goal exists
    expect(
      suggestGoals(recent, [{ period: 'year', metric: 'longest', sport: 'run' }], '2026-11-02', 1, '2026-01-01', 10).some(
        (g) => g.metric === 'longest',
      ),
    ).toBe(false);
  });
});
