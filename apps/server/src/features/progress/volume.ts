import {
  PROGRESS_VOLUME_METRICS,
  sportInfo,
  type ProgressBucket,
  type ProgressCompareResponse,
  type ProgressComparePeriod,
  type ProgressCompareTotals,
  type ProgressOverview,
  type ProgressSport,
  type ProgressTotals,
  type ProgressVolumeBucket,
  type ProgressVolumeMetric,
  type ProgressVolumeResponse,
  type ProgressWeeklySnapshot,
  type ProgressYoyResponse,
} from '@cadence/shared';
import { all, get, type Db } from '../../db/db';
import { addDays, dayString, parseDay } from '../../lib/time';
import {
  addRow,
  dailyActivity,
  emptyTotals,
  firstActivityDay,
  metricValue,
  roundTotals,
  sumRows,
  visibleWorkoutsInDays,
  weekStartOf,
} from './common';
import {
  bucketKey,
  bucketsBetween,
  endOfMonth,
  mustParseDay,
  referenceDayIndex,
  rollingMean,
  shiftMonths,
  shiftYears,
  startOfWeek,
} from './math';

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export function overview(db: Db, athleteId: number): ProgressOverview {
  const rows = all<{
    sport: string;
    count: number;
    distanceM: number;
    movingS: number;
    first: number;
    last: number;
  }>(
    db,
    `SELECT sport, COUNT(*) AS count, COALESCE(SUM(distance_m), 0) AS distanceM,
       COALESCE(SUM(COALESCE(moving_s, duration_s)), 0) AS movingS,
       MIN(start_ts + tz_min * 60) AS first, MAX(start_ts + tz_min * 60) AS last
     FROM workouts WHERE athlete_id = ? AND hidden = 0 AND duplicate_of IS NULL
     GROUP BY sport ORDER BY count DESC, sport`,
    [athleteId],
  );
  const efforts = new Map(
    all<{ sport: string; n: number }>(
      db,
      `SELECT be.sport, COUNT(DISTINCT be.workout_id) AS n FROM best_efforts be JOIN workouts w ON w.id = be.workout_id
       WHERE be.athlete_id = ? AND w.hidden = 0 AND w.duplicate_of IS NULL GROUP BY be.sport`,
      [athleteId],
    ).map((r) => [r.sport, r.n]),
  );
  const day = (localSec: number) => dayString(Math.floor(localSec / 86400));
  const sports: ProgressSport[] = rows.map((r) => ({
    sport: r.sport,
    count: r.count,
    distanceM: Math.round(r.distanceM),
    movingS: Math.round(r.movingS),
    firstDay: day(r.first),
    lastDay: day(r.last),
    bestEffortWorkouts: efforts.get(r.sport) ?? 0,
  }));
  return {
    sports,
    defaultSport: sports[0]?.sport ?? null,
    firstDay: sports.length ? sports.map((s) => s.firstDay).sort()[0]! : null,
    lastDay: sports.length ? sports.map((s) => s.lastDay).sort().at(-1)! : null,
    weekStart: weekStartOf(db, athleteId),
  };
}

// ---------------------------------------------------------------------------
// Volume per week / month / year
// ---------------------------------------------------------------------------

export function rollingWindowFor(bucket: ProgressBucket): number {
  return bucket === 'week' ? 4 : bucket === 'month' ? 3 : 0;
}

export function volume(
  db: Db,
  athleteId: number,
  q: { sport: string | null; bucket: ProgressBucket; fromDay: string; toDay: string },
): ProgressVolumeResponse {
  const weekStart = weekStartOf(db, athleteId);
  const window = rollingWindowFor(q.bucket);
  const visible = bucketsBetween(q.fromDay, q.toDay, q.bucket, weekStart);
  // load window-1 extra buckets before the range so the trailing average is defined from the first bucket
  let lead: ReturnType<typeof bucketsBetween> = [];
  if (window > 1 && visible.length) {
    const back =
      q.bucket === 'week'
        ? addDays(visible[0]!.fromDay, -7 * (window - 1))
        : shiftMonths(visible[0]!.fromDay, -(window - 1));
    lead = bucketsBetween(back, addDays(visible[0]!.fromDay, -1), q.bucket, weekStart);
  }
  const allBuckets = [...lead, ...visible];
  const out: ProgressVolumeBucket[] = allBuckets.map((b) => ({ ...b, total: emptyTotals(), bySport: {} }));
  const index = new Map(out.map((b, i) => [b.key, i]));
  const sports = new Set<string>();
  if (out.length) {
    for (const r of dailyActivity(db, athleteId, q.sport, out[0]!.fromDay, out.at(-1)!.toDay)) {
      const i = index.get(bucketKey(r.day, q.bucket, weekStart));
      if (i === undefined) continue;
      const b = out[i]!;
      addRow(b.total, r);
      addRow((b.bySport[r.sport] ??= emptyTotals()), r);
      if (i >= lead.length) sports.add(r.sport);
    }
  }
  const rolling = {} as Record<ProgressVolumeMetric, (number | null)[]>;
  for (const m of PROGRESS_VOLUME_METRICS) {
    const series = out.map((b) => metricValue(b.total, m));
    const avg = window > 1 ? rollingMean(series, window) : series.map(() => null);
    rolling[m] = avg.slice(lead.length).map((v) => (v === null ? null : Math.round(v * 10) / 10));
  }
  const shown = out.slice(lead.length).map((b) => ({
    ...b,
    total: roundTotals(b.total),
    bySport: Object.fromEntries(Object.entries(b.bySport).map(([s, t]) => [s, roundTotals(t)])),
  }));
  const totals = emptyTotals();
  for (const b of shown) {
    for (const k of Object.keys(totals) as (keyof ProgressTotals)[]) totals[k] += b.total[k];
  }
  return {
    bucket: q.bucket,
    weekStart,
    buckets: shown,
    sports: [...sports],
    rollingWindow: window > 1 ? window : 0,
    rolling,
    totals: roundTotals(totals),
  };
}

// ---------------------------------------------------------------------------
// Year over year
// ---------------------------------------------------------------------------

export const YOY_MAX_YEARS = 6;

export function yearOverYear(
  db: Db,
  athleteId: number,
  q: { sport: string | null; metric: ProgressVolumeMetric; today: string },
): ProgressYoyResponse {
  const year = Number(q.today.slice(0, 4));
  const todayIndex = referenceDayIndex(q.today);
  const first = firstActivityDay(db, athleteId, q.sport);
  if (!first) return { metric: q.metric, today: q.today, todayIndex, years: [], comparison: null };
  const firstYear = Math.max(Number(first.slice(0, 4)), year - YOY_MAX_YEARS + 1);
  if (firstYear > year) return { metric: q.metric, today: q.today, todayIndex, years: [], comparison: null };
  const daily = new Map<number, number[]>();
  for (let y = firstYear; y <= year; y++) daily.set(y, new Array<number>(366).fill(0));
  for (const r of dailyActivity(db, athleteId, q.sport, `${firstYear}-01-01`, q.today)) {
    const t = emptyTotals();
    addRow(t, r);
    daily.get(Number(r.day.slice(0, 4)))![referenceDayIndex(r.day)]! += metricValue(t, q.metric);
  }
  const years = [...daily.entries()].map(([y, values]) => {
    let sum = 0;
    const cumulative = values.map((v) => (sum += v)).map((v) => Math.round(v * 10) / 10);
    return {
      year: y,
      total: Math.round(sum * 10) / 10,
      cumulative: y === year ? cumulative.slice(0, todayIndex + 1) : cumulative,
    };
  });
  const cur = years.find((y) => y.year === year);
  const prev = years.find((y) => y.year === year - 1);
  let comparison: ProgressYoyResponse['comparison'] = null;
  if (cur && prev) {
    const value = cur.cumulative[todayIndex] ?? 0;
    const previousValue = prev.cumulative[todayIndex] ?? 0;
    comparison = {
      year,
      value,
      previousYear: year - 1,
      previousValue,
      diff: Math.round((value - previousValue) * 10) / 10,
      pct: previousValue > 0 ? (value - previousValue) / previousValue : null,
    };
  }
  return { metric: q.metric, today: q.today, todayIndex, years, comparison };
}

// ---------------------------------------------------------------------------
// Period comparison
// ---------------------------------------------------------------------------

export interface ComparisonRanges {
  current: [string, string];
  previous: [string, string];
  toDate: boolean;
}

/**
 * Current vs previous range. offset 0 = the running period up to today, compared with the previous period
 * cut to the same length ("to date"); offset n = the complete period n steps back vs the one before it.
 * custom = [fromDay, toDay] vs the equally long range right before it.
 */
export function comparisonRanges(
  period: ProgressComparePeriod,
  offset: number,
  today: string,
  weekStart: 0 | 1,
  custom?: { fromDay: string; toDay: string },
): ComparisonRanges {
  if (period === 'custom') {
    if (!custom) throw new Error('custom comparison needs fromDay and toDay');
    const a = mustParseDay(custom.fromDay);
    const b = mustParseDay(custom.toDay);
    const len = b - a + 1;
    return {
      current: [custom.fromDay, custom.toDay],
      previous: [dayString(a - len), dayString(a - 1)],
      toDate: false,
    };
  }
  const t = mustParseDay(today);
  if (period === 'week') {
    const ws = startOfWeek(t, weekStart) - 7 * offset;
    if (offset === 0)
      return {
        current: [dayString(ws), today],
        previous: [dayString(ws - 7), dayString(t - 7)],
        toDate: t < ws + 6,
      };
    return { current: [dayString(ws), dayString(ws + 6)], previous: [dayString(ws - 7), dayString(ws - 1)], toDate: false };
  }
  if (period === 'month') {
    const ms = shiftMonths(`${today.slice(0, 7)}-01`, -offset);
    const pm = shiftMonths(ms, -1);
    if (offset === 0)
      return { current: [ms, today], previous: [pm, shiftMonths(today, -1)], toDate: today !== endOfMonth(today) };
    return { current: [ms, endOfMonth(ms)], previous: [pm, endOfMonth(pm)], toDate: false };
  }
  const y = Number(today.slice(0, 4)) - offset;
  if (offset === 0)
    return {
      current: [`${y}-01-01`, today],
      previous: [`${y - 1}-01-01`, shiftYears(today, -1)],
      toDate: today.slice(5) !== '12-31',
    };
  return { current: [`${y}-01-01`, `${y}-12-31`], previous: [`${y - 1}-01-01`, `${y - 1}-12-31`], toDate: false };
}

export function compareTotals(
  db: Db,
  athleteId: number,
  sport: string | null,
  fromDay: string,
  toDay: string,
): ProgressCompareTotals {
  const rows = dailyActivity(db, athleteId, sport, fromDay, toDay);
  const base = sumRows(rows);
  const activeDays = new Set(rows.filter((r) => r.count > 0).map((r) => r.day)).size;
  const { where, params } = visibleWorkoutsInDays('', athleteId, sport, fromDay, toDay);
  const w = get<{
    hrSum: number | null;
    hrTime: number | null;
    longestM: number | null;
    longestS: number | null;
    dist: number | null;
    distTime: number | null;
  }>(
    db,
    `SELECT SUM(CASE WHEN avg_hr > 0 THEN avg_hr * COALESCE(moving_s, duration_s) END) AS hrSum,
       SUM(CASE WHEN avg_hr > 0 THEN COALESCE(moving_s, duration_s) END) AS hrTime,
       MAX(distance_m) AS longestM, MAX(COALESCE(moving_s, duration_s)) AS longestS,
       SUM(CASE WHEN distance_m > 0 THEN distance_m END) AS dist,
       SUM(CASE WHEN distance_m > 0 THEN COALESCE(moving_s, duration_s) END) AS distTime
     FROM workouts WHERE ${where}`,
    params,
  );
  const withSpeed = !!sport && sportInfo(sport).distance;
  return {
    ...roundTotals(base),
    activeDays,
    avgSpeed: withSpeed && w?.dist && w.distTime ? Math.round((w.dist / w.distTime) * 1000) / 1000 : null,
    avgHr: w?.hrSum && w.hrTime ? Math.round((w.hrSum / w.hrTime) * 10) / 10 : null,
    longestM: w?.longestM ? Math.round(w.longestM) : null,
    longestS: w?.longestS ? Math.round(w.longestS) : null,
  };
}

export function compare(
  db: Db,
  athleteId: number,
  q: {
    sport: string | null;
    period: ProgressComparePeriod;
    offset: number;
    today: string;
    fromDay?: string;
    toDay?: string;
  },
): ProgressCompareResponse {
  const ranges = comparisonRanges(
    q.period,
    q.offset,
    q.today,
    weekStartOf(db, athleteId),
    q.fromDay && q.toDay ? { fromDay: q.fromDay, toDay: q.toDay } : undefined,
  );
  const range = ([fromDay, toDay]: [string, string]) => ({
    fromDay,
    toDay,
    totals: compareTotals(db, athleteId, q.sport, fromDay, toDay),
  });
  return {
    period: q.period,
    offset: q.period === 'custom' ? 0 : q.offset,
    toDate: ranges.toDate,
    current: range(ranges.current),
    previous: range(ranges.previous),
  };
}

// ---------------------------------------------------------------------------
// Weekly snapshot (dashboard widget)
// ---------------------------------------------------------------------------

export function weeklySnapshot(db: Db, athleteId: number, today: string): ProgressWeeklySnapshot {
  const weekStart = weekStartOf(db, athleteId);
  const t = mustParseDay(today);
  const ws = startOfWeek(t, weekStart);
  const first = ws - 7 * 11;
  const rows = dailyActivity(db, athleteId, null, dayString(first), today);
  const weeks = Array.from({ length: 12 }, (_, i) => ({ key: dayString(first + 7 * i), totals: emptyTotals() }));
  const sumBetween = (a: number, b: number) => {
    const out = emptyTotals();
    for (const r of rows) {
      const d = parseDay(r.day)!;
      if (d >= a && d <= b) addRow(out, r);
    }
    return roundTotals(out);
  };
  for (const r of rows) {
    const i = Math.floor((parseDay(r.day)! - first) / 7);
    if (i >= 0 && i < 12) addRow(weeks[i]!.totals, r);
  }
  return {
    weekStart,
    current: { fromDay: dayString(ws), toDay: today, totals: sumBetween(ws, t) },
    previous: { fromDay: dayString(ws - 7), toDay: dayString(t - 7), totals: sumBetween(ws - 7, t - 7) },
    previousFull: { fromDay: dayString(ws - 7), toDay: dayString(ws - 1), totals: sumBetween(ws - 7, ws - 1) },
    weeks: weeks.map((w) => ({ key: w.key, totals: roundTotals(w.totals) })),
  };
}
