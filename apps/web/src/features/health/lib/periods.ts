import type { MetricAgg, MetricPoint, MetricSeries } from '@cadence/shared';
import { addDays, startOfMonth, startOfWeek, weekday } from '@/lib/time';

/** Start of the period a day belongs to: the day itself, its week (weekStart 1 = Monday, 0 = Sunday) or 'YYYY-MM-01'. */
export function periodStart(day: string, agg: MetricAgg, weekStart: 0 | 1): string {
  if (agg === 'day') return day;
  if (agg === 'month') return startOfMonth(day);
  return startOfWeek(day, weekStart);
}

function nextPeriod(key: string, agg: MetricAgg): string {
  if (agg === 'day') return addDays(key, 1);
  if (agg === 'week') return addDays(key, 7);
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${key.slice(0, 4)}-${m < 9 ? '0' : ''}${m + 1}-01`;
}

/** Every period start from the period of `fromDay` to the period of `toDay`, both included. */
export function periodKeys(fromDay: string, toDay: string, agg: MetricAgg, weekStart: 0 | 1): string[] {
  const out: string[] = [];
  const last = periodStart(toDay, agg, weekStart);
  for (let k = periodStart(fromDay, agg, weekStart); k <= last; k = nextPeriod(k, agg)) out.push(k);
  return out;
}

/**
 * Period keys a bar chart of a metric series shows: every period of the requested range, also those without data (the
 * server only sends periods that have some), so a gap in the tracking stays visible instead of joining its neighbours.
 */
export function seriesKeys(series: Pick<MetricSeries, 'agg' | 'fromDay' | 'toDay' | 'points' | 'categories'>, weekStart: 0 | 1): string[] {
  const have = [...series.points.map((p) => p.key), ...series.categories.flatMap((c) => c.points.map((p) => p.key))].sort();
  const from = series.fromDay ?? have[0];
  const to = series.toDay ?? have[have.length - 1];
  // weeks start where the server started them (the setting may have changed since the series was loaded)
  const first = series.agg === 'week' ? have[0] : undefined;
  const ws = first !== undefined && (weekday(first) === 0 || weekday(first) === 1) ? (weekday(first) as 0 | 1) : weekStart;
  const keys = from && to && from <= to ? periodKeys(from, to, series.agg, ws) : [];
  return [...new Set([...keys, ...have])].sort();
}

/**
 * Value of a period under the chosen mode: its total, or ('average', weeks and months) the daily average over its days
 * with data. Events (category types without duration) always show how many there were: dividing by the days that had
 * an event would make nearly every week "1".
 */
export function periodValue(p: MetricPoint, agg: MetricAgg, mode: 'average' | 'total', events = false): number {
  if (events) return p.n;
  return mode === 'average' && agg !== 'day' && p.days > 0 ? p.value / p.days : p.value;
}

/** One point per key; periods without data get a zero point (the true value of a cumulative measure). */
export function fillPeriods(points: MetricPoint[], keys: string[]): MetricPoint[] {
  const byKey = new Map(points.map((p) => [p.key, p]));
  return keys.map((key) => byKey.get(key) ?? { key, value: 0, min: null, max: null, n: 0, days: 0 });
}
