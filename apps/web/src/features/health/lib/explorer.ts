import type { Formatter } from '@/lib/format';

/** Explorer items whose first / last timestamps stand for whole days (UTC midnight of the day), not for instants. */
const DAY_ITEMS = new Set(['activitySummaries']);

/** Date of an explorer item's first or last entry: days as they are, instants in the browser's time zone. */
export function itemDate(fmt: Formatter, key: string, ts: number): string {
  return DAY_ITEMS.has(key) ? fmt.date(ts, 0, 'day') : fmt.browserDate(ts, 'day');
}
