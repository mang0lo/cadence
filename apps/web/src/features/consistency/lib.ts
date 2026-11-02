/** Formatting helpers of the consistency feature (pure; pass `fmt`/`t` from the hooks). */
import { M_PER_FT, M_PER_KM, M_PER_MI, type CalendarDay, type GoalInput, type GoalMetric, type GoalPeriod } from '@cadence/shared';
import type { Formatter } from '@/lib/format';
import type { Lang, TFunction } from '@/lib/i18n';
import { sportLabel } from '@/lib/sports';
import { addDays } from '@/lib/time';

export type CalendarMetric = 'minutes' | 'distance' | 'activities' | 'effort' | 'move';
export const CALENDAR_METRICS: CalendarMetric[] = ['minutes', 'distance', 'activities', 'effort', 'move'];

export function calendarValue(d: CalendarDay, m: CalendarMetric): number {
  switch (m) {
    case 'minutes':
      return d.durationS / 60;
    case 'distance':
      return d.distanceM;
    case 'activities':
      return d.count;
    case 'effort':
      return d.effort;
    case 'move':
      return d.move ?? 0;
  }
}

export function formatCalendarValue(fmt: Formatter, t: TFunction, m: CalendarMetric, v: number): string {
  switch (m) {
    case 'minutes':
      return fmt.durationShort(v * 60);
    case 'distance':
      return fmt.distance(v);
    case 'activities':
      return t('common.activities', { count: v });
    case 'effort':
      return fmt.int(v);
    case 'move':
      return fmt.pct(v);
  }
}

/** Goal / challenge quantity in canonical units → display string. */
export function formatGoalValue(fmt: Formatter, t: TFunction, metric: GoalMetric, v: number): string {
  switch (metric) {
    case 'distance':
      return fmt.distance(v, v > 0 && v < 10_000 ? 1 : 0);
    case 'time':
      return fmt.durationShort(v);
    case 'elevation':
      return fmt.elevation(v);
    case 'activities':
      return t('common.activities', { count: Math.round(v) });
    case 'active_days':
      return t('common.days', { count: Math.round(v) });
  }
}

/** Display unit for entering a goal target (km/mi, h, m/ft, count). */
export function targetUnit(fmt: Formatter, t: TFunction, metric: GoalMetric): string {
  switch (metric) {
    case 'distance':
      return fmt.distanceUnit;
    case 'time':
      return 'h';
    case 'elevation':
      return fmt.units === 'imperial' ? 'ft' : 'm';
    case 'activities':
      return t('consistency.goals.unit.activities');
    case 'active_days':
      return t('consistency.goals.unit.days');
  }
}

/** Canonical target → number shown in the form's input. */
export function toInputValue(fmt: Formatter, metric: GoalMetric, v: number): number {
  const imperial = fmt.units === 'imperial';
  const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
  switch (metric) {
    case 'distance':
      return round(v / (imperial ? M_PER_MI : M_PER_KM), 1);
    case 'time':
      return round(v / 3600, 2);
    case 'elevation':
      return Math.round(imperial ? v / M_PER_FT : v);
    default:
      return Math.round(v);
  }
}

/** Number typed in the form → canonical target. */
export function fromInputValue(fmt: Formatter, metric: GoalMetric, v: number): number {
  const imperial = fmt.units === 'imperial';
  switch (metric) {
    case 'distance':
      return v * (imperial ? M_PER_MI : M_PER_KM);
    case 'time':
      return v * 3600;
    case 'elevation':
      return imperial ? v * M_PER_FT : v;
    default:
      return Math.round(v);
  }
}

/** "Distance · Run" */
export function goalTitle(t: TFunction, lang: Lang, g: Pick<GoalInput, 'metric' | 'sport'>): string {
  const metric = t(`consistency.goals.metrics.${g.metric}`);
  return g.sport ? `${metric} · ${sportLabel(g.sport, lang)}` : metric;
}

/** "120 km per month" */
export function goalTargetText(fmt: Formatter, t: TFunction, g: Pick<GoalInput, 'metric' | 'target' | 'period'>): string {
  return t(`consistency.goals.per.${g.period}`, { value: formatGoalValue(fmt, t, g.metric, g.target) });
}

/** "2 – 8 Nov" style label of a period. */
export function periodLabel(fmt: Formatter, period: GoalPeriod, start: string, end: string): string {
  if (period === 'year') return start.slice(0, 4);
  if (period === 'month') return fmt.day(start, 'month');
  return `${fmt.day(start, 'dayShort')} – ${fmt.day(end, 'dayShort')}`;
}

/** Inclusive range label of two days ("3 Mar – 23 Mar 2025"). */
export function rangeLabel(fmt: Formatter, from: string, to: string): string {
  if (from === to) return fmt.day(from, 'day');
  return from.slice(0, 4) === to.slice(0, 4)
    ? `${fmt.day(from, 'dayShort')} – ${fmt.day(to, 'day')}`
    : `${fmt.day(from, 'day')} – ${fmt.day(to, 'day')}`;
}

/** Days of a month 'YYYY-MM'. */
export function monthDays(month: string): string[] {
  const out: string[] = [];
  for (let d = `${month}-01`; d.startsWith(month); d = addDays(d, 1)) out.push(d);
  return out;
}

/** JS weekday (0 = Sunday) of display column i for a week start. */
export const weekdayOfColumn = (i: number, weekStart: 0 | 1) => (i + weekStart) % 7;

/**
 * Apple's activity ring colors — used ONLY for the ring glyphs (and their legend), never in charts.
 * Light mode uses slightly deeper variants so the lime and cyan stay visible on white.
 */
export const RING_COLORS = {
  light: { move: '#f2124f', exercise: '#5fc400', stand: '#00b7d0' },
  dark: { move: '#fa114f', exercise: '#a6ff00', stand: '#00f0ff' },
} as const;

export type Ring = 'move' | 'exercise' | 'stand';
export const RINGS: Ring[] = ['move', 'exercise', 'stand'];
