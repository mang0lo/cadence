import {
  SLEEP_GENERIC_VALUES,
  SLEEP_STAGE_VALUES,
  categoryValueRole,
  dayFromNumber,
  dayNumber,
  mean,
  median,
  type MetricAgg,
  type MetricPoint,
  type MetricStats,
} from '@cadence/shared';

/** One daily_metrics row. */
export interface DailyRow {
  day: string;
  value: number;
  min: number | null;
  max: number | null;
  n: number;
}

/** Start of the period a day belongs to: the day itself, its week (weekStart 1 = Monday, 0 = Sunday) or 'YYYY-MM-01'. */
export function periodStart(day: string, agg: MetricAgg, weekStart: 0 | 1): string {
  if (agg === 'day') return day;
  if (agg === 'month') return `${day.slice(0, 7)}-01`;
  const dn = dayNumber(day);
  // 1970-01-01 was a Thursday (4); weekday 0 = Sunday
  const weekday = (((dn + 4) % 7) + 7) % 7;
  const back = (weekday - weekStart + 7) % 7;
  return dayFromNumber(dn - back);
}

/**
 * Daily rows → one point per day / week / month.
 *  - 'sum' and 'duration' (cumulative): `value` = total over the period;
 *  - 'avg': `value` = mean of the daily means (every day counts equally), `min` / `max` = extremes of the samples.
 */
export function aggregatePoints(
  rows: DailyRow[],
  agg: MetricAgg,
  weekStart: 0 | 1,
  aggregation: 'sum' | 'avg' | 'duration',
): MetricPoint[] {
  const groups = new Map<string, DailyRow[]>();
  for (const r of rows) {
    const key = periodStart(r.day, agg, weekStart);
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const out: MetricPoint[] = [];
  for (const [key, g] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const n = g.reduce((s, r) => s + r.n, 0);
    if (aggregation === 'avg') {
      const mins = g.flatMap((r) => (r.min === null ? [] : [r.min]));
      const maxs = g.flatMap((r) => (r.max === null ? [] : [r.max]));
      out.push({
        key,
        value: mean(g.map((r) => r.value))!,
        min: mins.length ? Math.min(...mins) : null,
        max: maxs.length ? Math.max(...maxs) : null,
        n,
        days: g.length,
      });
    } else {
      out.push({ key, value: g.reduce((s, r) => s + r.value, 0), min: null, max: null, n, days: g.length });
    }
  }
  return out;
}

/** Summary over the daily rows of a range. */
export function summarize(rows: DailyRow[], aggregation: 'sum' | 'avg' | 'duration'): MetricStats {
  if (!rows.length) {
    return { days: 0, samples: 0, min: null, max: null, mean: null, median: null, total: null, latestDay: null, latest: null, firstDay: null };
  }
  const values = rows.map((r) => r.value);
  const mins = rows.flatMap((r) => (r.min === null ? [] : [r.min]));
  const maxs = rows.flatMap((r) => (r.max === null ? [] : [r.max]));
  const last = rows[rows.length - 1]!;
  return {
    days: rows.length,
    samples: rows.reduce((s, r) => s + r.n, 0),
    min: aggregation === 'avg' && mins.length ? Math.min(...mins) : Math.min(...values),
    max: aggregation === 'avg' && maxs.length ? Math.max(...maxs) : Math.max(...values),
    mean: mean(values),
    median: median(values),
    total: aggregation === 'avg' ? null : values.reduce((s, v) => s + v, 0),
    latestDay: last.day,
    latest: last.value,
    firstDay: rows[0]!.day,
  };
}

const SLEEP = 'HKCategoryTypeIdentifierSleepAnalysis';

/**
 * Sleep written twice for the same night — in stages by the watch (Core / Deep / REM) and as a generic Asleep by
 * another app (AutoSleep, Sleep Cycle …) — is counted once: on a day with stages the generic rows are dropped, the
 * same "staged source wins" rule as the sleep nights. daily_metrics resolves sources only within one value, so this
 * has to happen here. Other types pass unchanged.
 */
export function withoutDuplicateSleep(rowsByValue: Map<string, DailyRow[]>, identifier: string): Map<string, DailyRow[]> {
  if (identifier !== SLEEP) return rowsByValue;
  const staged = new Set<string>();
  for (const v of SLEEP_STAGE_VALUES) for (const r of rowsByValue.get(v) ?? []) if (r.value > 0) staged.add(r.day);
  if (!staged.size) return rowsByValue;
  const out = new Map<string, DailyRow[]>();
  for (const [value, rows] of rowsByValue) {
    const keep = SLEEP_GENERIC_VALUES.includes(value) ? rows.filter((r) => !staged.has(r.day)) : rows;
    if (keep.length) out.set(value, keep);
  }
  return out;
}

/**
 * Per-day total over the values of a category type: minutes, and occurrences for events without a duration. Which
 * values count is declared per type (categoryValueRole: stand hours count Stood only, sleep leaves out InBed and
 * Awake …); the metric page and the explorer sparkline both use this.
 */
export function combineCategoryRows(
  rowsByValue: Map<string, DailyRow[]>,
  identifier: string,
): DailyRow[] {
  const days = new Map<string, DailyRow>();
  for (const [value, rows] of withoutDuplicateSleep(rowsByValue, identifier)) {
    const role = categoryValueRole(identifier, value);
    if (role === 'skip') continue;
    for (const r of rows) {
      let d = days.get(r.day);
      if (!d) days.set(r.day, (d = { day: r.day, value: 0, min: null, max: null, n: 0 }));
      if (role === 'add') {
        d.value += r.value;
        d.n += r.n;
      }
    }
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}
