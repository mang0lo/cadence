/**
 * Calendar helpers on 'YYYY-MM-DD' local day strings (pure). Built on the epoch-day functions of
 * lib/time so day math never goes through Date objects or the server's time zone.
 */
import type { GoalPeriod } from '@cadence/shared';
import { dayString, daysFromCivil, parseDay } from '../../lib/time';

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Epoch day number of a day string (throws on malformed input). */
export function epoch(day: string): number {
  const d = parseDay(day);
  if (d === null) throw new Error(`Invalid day ${day}`);
  return d;
}

export const fromEpoch = dayString;

export function plusDays(day: string, n: number): string {
  return dayString(epoch(day) + n);
}

/** b − a in days. */
export function daysBetween(a: string, b: string): number {
  return epoch(b) - epoch(a);
}

/** 0 = Sunday … 6 = Saturday (1970-01-01 was a Thursday). */
export function weekdayOfEpoch(e: number): number {
  return (((e + 4) % 7) + 7) % 7;
}

export function weekdayOf(day: string): number {
  return weekdayOfEpoch(epoch(day));
}

/** Epoch day of the first day of the week containing epoch day `e`. */
export function weekStartEpoch(e: number, weekStart: 0 | 1): number {
  return e - ((weekdayOfEpoch(e) - weekStart + 7) % 7);
}

export function weekStartOf(day: string, weekStart: 0 | 1): string {
  return dayString(weekStartEpoch(epoch(day), weekStart));
}

export function monthStartOf(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

export function monthEndOf(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return dayString(daysFromCivil(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - 1);
}

export function yearStartOf(day: string): string {
  return `${day.slice(0, 4)}-01-01`;
}

export function yearEndOf(day: string): string {
  return `${day.slice(0, 4)}-12-31`;
}

/** 'YYYY-MM' → number of days in that month. */
export function daysInMonth(month: string): number {
  return daysBetween(`${month}-01`, monthEndOf(`${month}-01`)) + 1;
}

/** Inclusive range of the period (day / week / month / year) containing `day`. */
export function periodRange(day: string, period: GoalPeriod, weekStart: 0 | 1): { start: string; end: string } {
  if (period === 'day') return { start: day, end: day };
  if (period === 'week') {
    const start = weekStartOf(day, weekStart);
    return { start, end: plusDays(start, 6) };
  }
  if (period === 'month') return { start: monthStartOf(day), end: monthEndOf(day) };
  return { start: yearStartOf(day), end: yearEndOf(day) };
}

/** Start day of the period before the one starting at `start`. */
export function previousPeriodStart(start: string, period: GoalPeriod): string {
  if (period === 'day') return plusDays(start, -1);
  if (period === 'week') return plusDays(start, -7);
  if (period === 'month') return monthStartOf(plusDays(start, -1));
  return `${Number(start.slice(0, 4)) - 1}-01-01`;
}

export const minDay = (a: string, b: string): string => (a < b ? a : b);
export const maxDay = (a: string, b: string): string => (a > b ? a : b);

/** Local wall-clock parts of a timestamp at offset tzMin. */
export function localParts(ts: number, tzMin: number): { day: string; weekday: number; hour: number } {
  const local = ts + tzMin * 60;
  const e = Math.floor(local / 86400);
  return { day: dayString(e), weekday: weekdayOfEpoch(e), hour: Math.floor((local - e * 86400) / 3600) };
}

/** Unix seconds of UTC midnight of a day (use with a ±14 h margin to cover every local offset). */
export function utcMidnight(day: string): number {
  return epoch(day) * 86400;
}

export const TZ_MARGIN_S = 14 * 3600;
