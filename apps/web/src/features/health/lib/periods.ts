import { periodKeys, periodStart, type MetricAgg, type MetricPoint, type MetricSeries } from '@cadence/shared';
import { diffDays, weekday } from '@/lib/time';

/** The periods of the server's series (start of a day / week / month, every period of a range): one shared helper. */
export { periodKeys, periodStart };

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

/**
 * Events per calendar day of a range, with the decimals to show it: rare events keep two significant digits (one
 * notification in a year is 0.0027 per day, not "0.00").
 */
export function eventsPerDay(events: number, fromDay: string | null, toDay: string | null): { value: number; digits: number } {
  const days = fromDay && toDay && fromDay <= toDay ? diffDays(fromDay, toDay) + 1 : 0;
  const value = days > 0 ? events / days : 0;
  const digits = value > 0 && value < 1 ? Math.min(4, Math.max(2, 1 - Math.floor(Math.log10(value)))) : 1;
  return { value, digits };
}

/** One point per key; periods without data get a zero point (the true value of a cumulative measure). */
export function fillPeriods(points: MetricPoint[], keys: string[]): MetricPoint[] {
  const byKey = new Map(points.map((p) => [p.key, p]));
  return keys.map((key) => byKey.get(key) ?? { key, value: 0, min: null, max: null, n: 0, days: 0 });
}
