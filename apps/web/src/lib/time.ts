/**
 * Date helpers that respect the data conventions: timestamps are unix seconds, every timestamp has
 * its own local offset (`tzMin`), and calendar days are 'YYYY-MM-DD' strings in local time.
 * A "local date" is a Date shifted by the offset — always read it with getUTC* methods.
 */

export const DAY_S = 86_400;

export const nowTs = (): number => Math.floor(Date.now() / 1000);

/** Wall-clock date of `ts` at offset `tzMin` (read with getUTC* methods!). */
export function localDate(ts: number, tzMin: number): Date {
  return new Date((ts + tzMin * 60) * 1000);
}

export function localHour(ts: number, tzMin: number): number {
  return localDate(ts, tzMin).getUTCHours();
}

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

function keyOfUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 'YYYY-MM-DD' local day of a timestamp. */
export function dayKey(ts: number, tzMin: number): string {
  return keyOfUtc(localDate(ts, tzMin));
}

/** Today in the browser's local time zone. */
export function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** UTC-midnight Date for a day key. */
export function dayToDate(day: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(day: string, n: number): string {
  const d = dayToDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return keyOfUtc(d);
}

/** b − a in whole days. */
export function diffDays(a: string, b: string): number {
  return Math.round((dayToDate(b).getTime() - dayToDate(a).getTime()) / (DAY_S * 1000));
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(day: string): number {
  return dayToDate(day).getUTCDay();
}

/** First day of the week containing `day`; weekStart 1 = Monday, 0 = Sunday. */
export function startOfWeek(day: string, weekStart: 0 | 1 = 1): string {
  const wd = weekday(day);
  const back = (wd - weekStart + 7) % 7;
  return addDays(day, -back);
}

export function startOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

export function startOfYear(day: string): string {
  return `${day.slice(0, 4)}-01-01`;
}

/** Inclusive list of days. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * The browser's UTC offset in minutes at the instant `ts` (DST-aware). Use it for timestamps that have no `tzMin` of
 * their own (import jobs, sync times, first/last record) — never `-new Date().getTimezoneOffset()`, which is today's
 * offset and wrong by an hour for instants in the other half of the year.
 */
export function browserTzAt(ts: number): number {
  return -new Date(ts * 1000).getTimezoneOffset();
}

/**
 * Unix seconds of local midnight for a day key at offset `tzMin`. Without `tzMin`: midnight in the browser's time
 * zone on that day, with that day's offset (a summer day keeps summer time while today is in winter time).
 */
export function dayStartTs(day: string, tzMin?: number): number {
  if (tzMin === undefined) {
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    return Math.floor(new Date(y, m - 1, d).getTime() / 1000);
  }
  return Math.floor(dayToDate(day).getTime() / 1000) - tzMin * 60;
}

export type Period = 'week' | 'month' | 'year';

/** Bucket key for a day: week start day, 'YYYY-MM' or 'YYYY'. */
export function periodKey(day: string, period: Period, weekStart: 0 | 1 = 1): string {
  if (period === 'week') return startOfWeek(day, weekStart);
  if (period === 'month') return day.slice(0, 7);
  return day.slice(0, 4);
}
