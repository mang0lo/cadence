/**
 * Goal math (pure, unit-tested): period values, "on track / behind" projection, history of past
 * periods, suggestions from recent averages and the defaults used when an athlete has no goals.
 */
import {
  LONGEST_PRESETS,
  sportInfo,
  type GoalInput,
  type GoalMetric,
  type GoalPeriod,
  type GoalPeriodProgress,
  type GoalPeriodResult,
  type GoalSuggestion,
} from '@cadence/shared';
import { daysBetween, periodRange, plusDays, previousPeriodStart } from './days';

/** One row of daily_activity (workout totals of one sport on one local day). */
export interface DailyRow {
  day: string;
  sport: string;
  count: number;
  durationS: number;
  distanceM: number;
  elevationM: number;
  effort: number;
  energyKcal: number;
  /** Longest single activity of that sport on that day (m). */
  longestM?: number;
}

export const PERIOD_DAYS_MAX: Record<GoalPeriod, number> = { week: 7, month: 31, year: 366 };

/** How many completed periods the history shows. */
export const HISTORY_LENGTH: Record<GoalPeriod, number> = { week: 12, month: 12, year: 5 };

/** Value of a goal metric over rows (already restricted to one period). */
export function goalValue(rows: Iterable<DailyRow>, metric: GoalMetric, sport: string | null): number {
  let v = 0;
  const days = new Set<string>();
  for (const r of rows) {
    if (r.count <= 0 || (sport !== null && r.sport !== sport)) continue;
    switch (metric) {
      case 'distance':
        v += r.distanceM;
        break;
      case 'longest':
        v = Math.max(v, r.longestM ?? 0);
        break;
      case 'time':
        v += r.durationS;
        break;
      case 'elevation':
        v += r.elevationM;
        break;
      case 'activities':
        v += r.count;
        break;
      case 'active_days':
        days.add(r.day);
        break;
    }
  }
  return metric === 'active_days' ? days.size : v;
}

/** Rows whose day lies inside [start, end] (rows sorted by day → binary search would do; n is small). */
export function rowsIn(rows: DailyRow[], start: string, end: string): DailyRow[] {
  return rows.filter((r) => r.day >= start && r.day <= end);
}

/**
 * Progress of the period [start, end] as of `asOf`. The expectation is pro rata by the START of asOf, so a
 * morning without training yet is not "behind"; the projection extrapolates the pace including asOf.
 */
export function goalProjection(o: {
  value: number;
  target: number;
  start: string;
  end: string;
  asOf: string;
  /** A single-activity goal (`longest`): reached or still open, there is no pace to project. */
  single?: boolean;
}): GoalPeriodProgress {
  const totalDays = daysBetween(o.start, o.end) + 1;
  const elapsedDays = Math.max(0, Math.min(totalDays, daysBetween(o.start, o.asOf)));
  const remainingDays = totalDays - elapsedDays;
  const target = Math.max(0, o.target);
  const expected = totalDays ? (target * elapsedDays) / totalDays : target;
  const projected = (o.value * totalDays) / Math.max(1, Math.min(totalDays, elapsedDays + 1));
  const remaining = Math.max(0, target - o.value);
  const status = o.value >= target ? 'done' : o.single ? 'open' : o.value + 1e-9 >= expected ? 'on_track' : 'behind';
  return {
    start: o.start,
    end: o.end,
    value: o.value,
    target,
    fraction: target > 0 ? o.value / target : 1,
    elapsedDays,
    totalDays,
    expected: o.single ? 0 : expected,
    projected: o.single ? o.value : projected,
    status,
    remaining,
    remainingDays,
    perDayNeeded: !o.single && remaining > 0 && remainingDays > 0 ? remaining / remainingDays : null,
  };
}

/** The classic distance just above `longestM` for a sport (half marathon after 15 km …), or null. */
export function nextMilestone(sport: string | null, longestM: number): number | null {
  const ladder = LONGEST_PRESETS[(sport ?? '') as keyof typeof LONGEST_PRESETS];
  if (!ladder) return null;
  return ladder.find((p) => p.distanceM > longestM * 1.02)?.distanceM ?? null;
}

/** Bucket rows by the start day of their period. */
export function bucketByPeriod(rows: DailyRow[], period: GoalPeriod, weekStart: 0 | 1): Map<string, DailyRow[]> {
  const out = new Map<string, DailyRow[]>();
  for (const r of rows) {
    const k = periodRange(r.day, period, weekStart).start;
    let list = out.get(k);
    if (!list) out.set(k, (list = []));
    list.push(r);
  }
  return out;
}

/**
 * Completed periods before the one containing `asOf`, oldest first, back to the period containing
 * `firstDay` (at most HISTORY_LENGTH[period] entries).
 */
export function goalHistory(
  goal: GoalInput,
  buckets: Map<string, DailyRow[]>,
  asOf: string,
  weekStart: 0 | 1,
  firstDay: string | null,
  length = HISTORY_LENGTH[goal.period],
): GoalPeriodResult[] {
  if (!firstDay) return [];
  const out: GoalPeriodResult[] = [];
  let start = previousPeriodStart(periodRange(asOf, goal.period, weekStart).start, goal.period);
  while (out.length < length) {
    const range = periodRange(start, goal.period, weekStart);
    if (range.end < firstDay) break;
    const value = goalValue(buckets.get(range.start) ?? [], goal.metric, goal.sport);
    out.push({ start: range.start, end: range.end, value, hit: value >= goal.target });
    start = previousPeriodStart(range.start, goal.period);
  }
  return out.reverse();
}

/** Round to a number people would pick as a goal (2.5, 25, 30, 125, 1,500 …). */
export function roundNice(v: number): number {
  if (!(v > 0)) return 0;
  const m = 10 ** Math.floor(Math.log10(v));
  const r = v / m;
  const step = m * (r < 2.5 ? 0.25 : r < 5 ? 0.5 : 1);
  return Math.max(step, Math.round(v / step) * step);
}

/** A target from an average per period: a ~10 % stretch, rounded to a nice number in display-friendly units. */
export function niceTarget(metric: GoalMetric, period: GoalPeriod, average: number, stretch = 1.1): number {
  const v = average * stretch;
  switch (metric) {
    case 'active_days':
      return Math.max(1, Math.min(PERIOD_DAYS_MAX[period] - (period === 'year' ? 1 : 0), period === 'year' ? Math.round(v / 5) * 5 : Math.round(v)));
    case 'activities':
      return Math.max(1, period === 'year' ? Math.round(v / 5) * 5 : Math.round(v));
    case 'time':
      // nice in hours from 2 h on ("6 h"), else in minutes ("90 min")
      return v >= 7200 ? roundNice(v / 3600) * 3600 : roundNice(v / 60) * 60;
    case 'distance':
      return Math.max(1000, roundNice(v));
    case 'longest':
      // whole kilometres from 10 km on, else half kilometres
      return v >= 10_000 ? Math.round(v / 1000) * 1000 : Math.max(500, Math.round(v / 500) * 500);
    case 'elevation':
      return Math.max(100, roundNice(v));
  }
}

export interface AverageResult {
  average: number;
  periods: number;
}

/**
 * Average value per complete period over the `count` periods before the one containing `asOf`,
 * counting only periods that end on/after `firstDay`.
 */
export function recentAverage(
  goal: Pick<GoalInput, 'period' | 'metric' | 'sport'>,
  buckets: Map<string, DailyRow[]>,
  asOf: string,
  weekStart: 0 | 1,
  firstDay: string | null,
  count: number,
): AverageResult {
  const hist = goalHistory({ ...goal, target: Infinity }, buckets, asOf, weekStart, firstDay, count);
  if (!hist.length) return { average: 0, periods: 0 };
  return { average: hist.reduce((s, h) => s + h.value, 0) / hist.length, periods: hist.length };
}

/** Distance sport with the most distance in the given rows (null if none). */
export function topDistanceSport(rows: DailyRow[]): string | null {
  const by = new Map<string, number>();
  for (const r of rows) if (sportInfo(r.sport).distance && r.distanceM > 0) by.set(r.sport, (by.get(r.sport) ?? 0) + r.distanceM);
  let best: string | null = null;
  let max = 0;
  for (const [s, d] of by)
    if (d > max) {
      max = d;
      best = s;
    }
  return best;
}

/** Sum of a metric over the 365 days ending at asOf (yearly suggestions without a complete year). */
function trailingYear(rows: DailyRow[], metric: GoalMetric, sport: string | null, asOf: string): number {
  return goalValue(rowsIn(rows, plusDays(asOf, -364), asOf), metric, sport);
}

const sameGoal = (a: Pick<GoalInput, 'period' | 'metric' | 'sport'>, b: Pick<GoalInput, 'period' | 'metric' | 'sport'>) =>
  a.period === b.period && a.metric === b.metric && (a.sport ?? null) === (b.sport ?? null);

/** Suggested goals from recent averages, excluding combinations that already exist. */
export function suggestGoals(
  rows: DailyRow[],
  existing: Pick<GoalInput, 'period' | 'metric' | 'sport'>[],
  asOf: string,
  weekStart: 0 | 1,
  firstDay: string | null,
  max = 5,
): GoalSuggestion[] {
  if (!firstDay || !rows.length) return [];
  const recent = rowsIn(rows, plusDays(asOf, -180), asOf);
  const top = topDistanceSport(recent.length ? recent : rows);
  const candidates: Pick<GoalInput, 'period' | 'metric' | 'sport'>[] = [
    { period: 'week', metric: 'active_days', sport: null },
    { period: 'week', metric: 'time', sport: null },
    ...(top
      ? ([
          { period: 'week', metric: 'distance', sport: top },
          { period: 'month', metric: 'distance', sport: top },
          { period: 'year', metric: 'distance', sport: top },
        ] as const)
      : []),
    { period: 'month', metric: 'elevation', sport: null },
    { period: 'month', metric: 'activities', sport: null },
    { period: 'year', metric: 'active_days', sport: null },
  ];
  const weekB = bucketByPeriod(rows, 'week', weekStart);
  const monthB = bucketByPeriod(rows, 'month', weekStart);
  const out: GoalSuggestion[] = [];
  // a bigger single effort early in the list: the next classic distance above the longest of the last year
  // (10K → half → marathon …)
  const longC = { period: 'year', metric: 'longest', sport: top } as const;
  let longSuggestion: GoalSuggestion | null = null;
  if (top && !existing.some((e) => sameGoal(e, longC))) {
    const longest = goalValue(rowsIn(rows, plusDays(asOf, -364), asOf), 'longest', top);
    const next = nextMilestone(top, longest);
    if (longest > 0 && next) longSuggestion = { ...longC, target: next, average: longest, periods: 1 };
  }
  for (const c of candidates) {
    if (longSuggestion && out.length === 1) out.push(longSuggestion);
    if (out.length >= max) break;
    if (existing.some((e) => sameGoal(e, c))) continue;
    let avg: AverageResult;
    if (c.period === 'year') {
      const span = daysBetween(firstDay, asOf) + 1;
      if (span < 120) continue;
      const v = trailingYear(rows, c.metric, c.sport, asOf) * (365 / Math.min(365, span));
      avg = { average: v, periods: 1 };
    } else {
      avg = recentAverage(c, c.period === 'week' ? weekB : monthB, asOf, weekStart, firstDay, c.period === 'week' ? 8 : 6);
      if (avg.periods < 2) continue;
    }
    if (avg.average <= 0) continue;
    if (c.metric === 'elevation' && avg.average < 200) continue;
    out.push({ ...c, target: niceTarget(c.metric, c.period, avg.average), average: avg.average, periods: avg.periods });
    if (out.length >= max) break;
  }
  if (longSuggestion && !out.includes(longSuggestion) && out.length < max) out.push(longSuggestion);
  return out;
}

/** Sensible starting goals: 3+ active days and the WHO's 150 min per week, plus a monthly distance goal. */
export function defaultGoals(rows: DailyRow[], asOf: string, weekStart: 0 | 1, firstDay: string | null): GoalInput[] {
  const weekB = bucketByPeriod(rows, 'week', weekStart);
  const days = recentAverage({ period: 'week', metric: 'active_days', sport: null }, weekB, asOf, weekStart, firstDay, 8);
  const time = recentAverage({ period: 'week', metric: 'time', sport: null }, weekB, asOf, weekStart, firstDay, 8);
  const out: GoalInput[] = [
    {
      period: 'week',
      sport: null,
      metric: 'active_days',
      target: days.periods ? Math.max(3, Math.min(6, Math.round(days.average))) : 3,
    },
    {
      period: 'week',
      sport: null,
      metric: 'time',
      target: Math.max(150 * 60, time.periods ? niceTarget('time', 'week', time.average, 1) : 0),
    },
  ];
  const recent = rowsIn(rows, plusDays(asOf, -180), asOf);
  const top = topDistanceSport(recent);
  if (top) {
    const monthB = bucketByPeriod(rows, 'month', weekStart);
    const dist = recentAverage({ period: 'month', metric: 'distance', sport: top }, monthB, asOf, weekStart, firstDay, 3);
    if (dist.periods && dist.average > 0)
      out.push({ period: 'month', sport: top, metric: 'distance', target: niceTarget('distance', 'month', dist.average, 1) });
  }
  return out;
}

/** True when `target` can be reached at all within the period (active days ≤ days of the period). */
export function isFeasible(goal: GoalInput): boolean {
  if (!(goal.target > 0) || !Number.isFinite(goal.target)) return false;
  if (goal.metric === 'active_days') return goal.target <= PERIOD_DAYS_MAX[goal.period];
  return true;
}
