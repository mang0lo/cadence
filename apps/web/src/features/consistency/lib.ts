/** Formatting helpers of the consistency feature (pure; pass `fmt`/`t` from the hooks). */
import {
  M_PER_FT,
  M_PER_KM,
  M_PER_MI,
  goalMetricsFor,
  type CalendarDay,
  type GoalInput,
  type GoalMetric,
  type GoalPeriod,
  type GoalWithProgress,
  type YearReview,
} from '@cadence/shared';
import type { Formatter } from '@/lib/format';
import type { Lang, TFunction } from '@/lib/i18n';
import { sportLabel } from '@/lib/sports';
import { addDays, diffDays } from '@/lib/time';

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

/** The calendar metric to show: a stored 'move' only where the year has activity ring data, else active time. */
export function shownCalendarMetric(metric: CalendarMetric, hasRings: boolean): CalendarMetric {
  return CALENDAR_METRICS.includes(metric) && (metric !== 'move' || hasRings) ? metric : 'minutes';
}

// ---------------------------------------------------------------------------
// Goal quantities: display, form input and parsing in one place
// ---------------------------------------------------------------------------

/**
 * How a goal quantity is rounded for display: what was reached rounds down (a value just below the target never
 * prints as the target), what is still missing rounds up, targets and averages round to the nearest.
 */
export type GoalRounding = 'nearest' | 'down' | 'up';

function roundTo(v: number, digits: number, rounding: GoalRounding): number {
  const f = 10 ** digits;
  const x = v * f;
  // the epsilon absorbs binary noise (0.29 × 100 = 28.999…)
  const r = rounding === 'down' ? Math.floor(x + 1e-9) : rounding === 'up' ? Math.ceil(x - 1e-9) : Math.round(x);
  return r / f;
}

/**
 * Share of its target from which a single distance ('longest' goal) counts as reached: the GPS tolerance of the
 * distance trophies, the same as the server's DISTANCE_TOLERANCE (apps/server/src/features/consistency/challenges.ts).
 */
export const DISTANCE_TOLERANCE = 0.995;

/**
 * Rounding of a progress value: down while it is below the target, to the nearest once it is reached. A single
 * distance ('longest', the goal's `metric`) is reached within DISTANCE_TOLERANCE like on the server, so 42,150 m of a
 * 42,195 m goal show as 42.2 km, not as 42.1 km next to a reached goal.
 */
export const reachedRounding = (value: number, target: number, metric: GoalMetric): GoalRounding =>
  value < (metric === 'longest' ? target * DISTANCE_TOLERANCE : target) ? 'down' : 'nearest';

/** A small remainder (< 1 km / mi) in m or yd, rounded up: "45 m more" instead of "0 km more". */
function smallDistanceUp(fmt: Formatter, m: number): string {
  const unitM = fmt.units === 'imperial' ? 0.9144 : 1;
  return fmt.shortDistance(Math.ceil(m / unitM - 1e-9) * unitM);
}

/** Distance of a period total: one decimal below 10 (in the displayed unit, km or mi). */
function goalDistance(fmt: Formatter, m: number, rounding: GoalRounding): string {
  const v = fmt.distanceValue(m);
  if (rounding === 'up' && m > 0 && v < 1) return smallDistanceUp(fmt, m);
  const digits = m > 0 && v < 10 ? 1 : 0;
  return `${fmt.num(roundTo(v, digits, rounding), digits)} ${fmt.distanceUnit}`;
}

/** Distance with one decimal only where needed (3.8 km, 21.1 km, 100 km): classic single distances, trophies. */
export function classicDistance(fmt: Formatter, m: number, rounding: GoalRounding = 'nearest'): string {
  const v = fmt.distanceValue(m);
  if (rounding === 'up' && m > 0 && v < 1) return smallDistanceUp(fmt, m);
  const shown = roundTo(v, 1, rounding);
  return `${fmt.num(shown, Number.isInteger(shown) ? 0 : 1)} ${fmt.distanceUnit}`;
}

/** Elevation in m or ft. */
export function goalElevation(fmt: Formatter, m: number, rounding: GoalRounding = 'nearest'): string {
  const v = fmt.units === 'imperial' ? m / M_PER_FT : m;
  return `${fmt.num(roundTo(v, 0, rounding))} ${fmt.elevationParts(0).unit}`;
}

/** Goal / challenge quantity in canonical units → display string. */
export function formatGoalValue(
  fmt: Formatter,
  t: TFunction,
  metric: GoalMetric,
  v: number,
  rounding: GoalRounding = 'nearest',
): string {
  switch (metric) {
    case 'distance':
      return goalDistance(fmt, v, rounding);
    case 'longest':
      return classicDistance(fmt, v, rounding);
    case 'time': {
      // goals are about whole minutes ("30 min per day")
      const min = roundTo(v / 60, 0, rounding);
      return min > 0 ? fmt.durationShort(min * 60) : t('consistency.goals.zeroTime');
    }
    case 'elevation':
      return goalElevation(fmt, v, rounding);
    case 'calories':
      return fmt.energy(roundTo(v, 0, rounding));
    case 'activities':
    case 'active_days': {
      const n = roundTo(v, 0, rounding);
      return t(`consistency.common.${metric === 'activities' ? 'activities' : 'days'}`, { count: n, n: fmt.int(n) });
    }
  }
}

/** Time targets are entered in minutes for a day ("30 min per day") and in hours for longer periods. */
const timeUnitS = (period?: GoalPeriod): number => (period === 'day' ? 60 : 3600);

/** Display unit for entering a goal target (km/mi, h or min, m/ft, kcal, count). */
export function targetUnit(fmt: Formatter, t: TFunction, metric: GoalMetric, period?: GoalPeriod): string {
  switch (metric) {
    case 'distance':
    case 'longest':
      return fmt.distanceUnit;
    case 'time':
      return period === 'day' ? t('consistency.goals.unit.minutes') : 'h';
    case 'elevation':
      return fmt.units === 'imperial' ? 'ft' : 'm';
    case 'calories':
      return 'kcal';
    case 'activities':
      return t('consistency.goals.unit.activities');
    case 'active_days':
      return t('consistency.goals.unit.days');
  }
}

/** Canonical target → number shown in the form's input. */
export function toInputValue(fmt: Formatter, metric: GoalMetric, v: number, period?: GoalPeriod): number {
  const imperial = fmt.units === 'imperial';
  const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
  switch (metric) {
    case 'distance':
    case 'longest':
      return round(v / (imperial ? M_PER_MI : M_PER_KM), metric === 'longest' ? 3 : 1);
    case 'time':
      return round(v / timeUnitS(period), period === 'day' ? 0 : 2);
    case 'elevation':
      return Math.round(imperial ? v / M_PER_FT : v);
    default:
      return Math.round(v);
  }
}

/** Number typed in the form → canonical target. */
export function fromInputValue(fmt: Formatter, metric: GoalMetric, v: number, period?: GoalPeriod): number {
  const imperial = fmt.units === 'imperial';
  switch (metric) {
    case 'distance':
    case 'longest':
      return v * (imperial ? M_PER_MI : M_PER_KM);
    case 'time':
      // whole minutes: 1.67 h is the 100 min it was shown for, not 6012 s
      return Math.round((v * timeUnitS(period)) / 60) * 60;
    case 'elevation':
      return imperial ? v * M_PER_FT : v;
    default:
      return Math.round(v);
  }
}

const inputFormatCache = new Map<string, Intl.NumberFormat>();

/** Canonical target → text of the form's input: the locale's decimal separator, no grouping ("42,195", "1000"). */
export function goalInputText(fmt: Formatter, metric: GoalMetric, v: number, period?: GoalPeriod): string {
  let f = inputFormatCache.get(fmt.locale);
  if (!f) {
    f = new Intl.NumberFormat(fmt.locale, { useGrouping: false, maximumFractionDigits: 3 });
    inputFormatCache.set(fmt.locale, f);
  }
  return f.format(toInputValue(fmt, metric, v, period));
}

/** The editable fields of the goal form (`sport` 'all' = every sport; `target` as typed). */
export interface GoalForm {
  period: GoalPeriod;
  sport: string;
  metric: GoalMetric;
  target: string;
}

/** Display unit of a goal measure: time is in minutes for a day and in hours otherwise. */
const unitKey = (f: Pick<GoalForm, 'metric' | 'period'>) => (f.metric === 'time' && f.period === 'day' ? 'time-min' : f.metric);

/** Canonical target typed into the form (NaN when it is not a number). */
function parseTarget(fmt: Formatter, f: GoalForm): number {
  // single distances are entered with up to three decimals (42.195 km): a lone separator there is a decimal point
  const v = fmt.parseNumber(f.target, f.metric === 'longest');
  return Number.isFinite(v) ? fromInputValue(fmt, f.metric, v, f.period) : NaN;
}

/**
 * The goal form after its period or sport changed. A measure the new combination does not have (distance for
 * strength training, active days for a single day) falls back to time and clears the number, which meant something
 * else; a time target keeps its amount when its unit changes (minutes per day ↔ hours).
 */
export function changeGoalForm(fmt: Formatter, form: GoalForm, change: Partial<Pick<GoalForm, 'period' | 'sport'>>): GoalForm {
  const next = { ...form, ...change };
  if (!goalMetricsFor(next.sport === 'all' ? null : next.sport, next.period).includes(form.metric))
    return { ...next, metric: 'time', target: '' };
  if (unitKey(next) !== unitKey(form)) {
    const canonical = parseTarget(fmt, form);
    if (canonical > 0) next.target = goalInputText(fmt, next.metric, canonical, next.period);
  }
  return next;
}

/** A target the goal form was filled with, kept exactly while the form still shows it (see formTarget). */
export interface GoalFormExact {
  form: GoalForm;
  target: number;
}

/**
 * The goal form filled with a stored or picked target (the input shows it rounded, in the locale's number format).
 * A combination the catalogue does not have (an older goal, a sport without distance) falls back like a changed
 * sport would, and then there is no exact target to keep: it was a number in another unit, and the emptied field
 * must not stand for it (a 50 km goal would be saved as 50,000 s of time).
 */
export function fillGoalForm(
  fmt: Formatter,
  f: Omit<GoalForm, 'target'>,
  canonical: number,
): { form: GoalForm; exact: GoalFormExact | null } {
  const form = changeGoalForm(fmt, { ...f, target: goalInputText(fmt, f.metric, canonical, f.period) }, {});
  return { form, exact: form.metric === f.metric ? { form, target: canonical } : null };
}

/**
 * Canonical target of the form. `exact` is a target the form was filled with (the goal being edited, a quick pick):
 * while its number and unit are untouched, the stored value is kept as is, not re-read from the rounded text.
 */
export function formTarget(fmt: Formatter, form: GoalForm, exact?: GoalFormExact | null): number {
  if (exact && form.target === exact.form.target && unitKey(form) === unitKey(exact.form)) return exact.target;
  return parseTarget(fmt, form);
}

/** "Distance · Run" */
export function goalTitle(t: TFunction, lang: Lang, g: Pick<GoalInput, 'metric' | 'sport'>): string {
  const metric = t(`consistency.goals.metrics.${g.metric}`);
  return g.sport ? `${metric} · ${sportLabel(g.sport, lang)}` : metric;
}

/** "120 km per month" */
export function goalTargetText(fmt: Formatter, t: TFunction, g: Pick<GoalInput, 'metric' | 'target' | 'period'>): string {
  // a single activity: "42.2 km in one go, this year"
  const key = g.metric === 'longest' ? 'consistency.goals.once' : 'consistency.goals.per';
  return t(`${key}.${g.period}`, { value: formatGoalValue(fmt, t, g.metric, g.target) });
}

/**
 * One line telling where the goal stands: projection, what is left per day, or that it was reached. `asOfActive`: the
 * day the numbers refer to already is an active day for this goal, so it cannot add another one.
 */
export function goalOutlook(g: GoalWithProgress, t: TFunction, fmt: Formatter, asOfActive = false): string {
  const c = g.current;
  const v = (x: number, rounding: GoalRounding = 'nearest') => formatGoalValue(fmt, t, g.metric, x, rounding);
  const reached = (x: number) => v(x, reachedRounding(x, c.target, g.metric));
  if (c.checked) return t('consistency.goals.checkedText', { value: reached(c.value) });
  if (c.status === 'done') return t('consistency.goals.doneText', { pct: fmt.pct(c.fraction) });
  // a day has no pace: what is left, or that nothing was tracked yet
  if (g.period === 'day' && g.metric !== 'longest')
    return c.value > 0 ? t('consistency.goals.remainingToday', { value: v(c.remaining, 'up') }) : t('consistency.goals.nothingToday');
  // a single effort: the longest so far and what is still missing to the target
  if (g.metric === 'longest')
    return c.value > 0
      ? t('consistency.goals.longestSoFar', { value: reached(c.value), remaining: v(c.remaining, 'up'), days: t('common.days', { count: c.remainingDays }) })
      : t('consistency.goals.longestNone', { days: t('common.days', { count: c.remainingDays }) });
  // days that can still add an active day: the remaining ones, without asOf once it counts
  const openDays = g.metric === 'active_days' && asOfActive ? c.remainingDays - 1 : c.remainingDays;
  if (g.metric === 'active_days' && c.remaining > openDays) return t(`consistency.goals.outOfReach.${g.period}`);
  // a projection needs a pace: nothing done on the first day(s) would project 0
  const parts = c.value > 0 && c.elapsedDays > 0 ? [t(`consistency.goals.projected.${g.period}`, { value: reached(c.projected) })] : [];
  if (c.perDayNeeded !== null)
    parts.push(
      g.metric === 'active_days'
        ? t('consistency.goals.remainingDays', { count: Math.ceil(c.remaining), days: t('common.days', { count: openDays }) })
        : t('consistency.goals.remaining', {
            value: v(c.remaining, 'up'),
            perDay: v(c.perDayNeeded, 'up'),
            days: t('common.days', { count: c.remainingDays }),
          }),
    );
  return parts.join(' · ');
}

/**
 * Weeks covered by a year review's totals, for its "per week" average: from Jan 1, or the first day with data (the
 * first year of data is usually partial), to Dec 31, or `asOf` while the year is still running.
 */
export function reviewWeeks(r: Pick<YearReview, 'year' | 'complete' | 'firstDay' | 'asOf'>): number {
  const jan1 = `${r.year}-01-01`;
  const start = r.firstDay && r.firstDay > jan1 ? r.firstDay : jan1;
  const end = r.complete ? `${r.year}-12-31` : r.asOf;
  return Math.max(1, (diffDays(start, end) + 1) / 7);
}

/** The data covers the year before `year` (at most January missing): only then is a comparison with it meaningful. */
export function previousYearCovered(firstDay: string | null, year: number): boolean {
  return !firstDay || firstDay <= `${year - 1}-01-31`;
}

/** "2 – 8 Nov" style label of a period. */
export function periodLabel(fmt: Formatter, period: GoalPeriod, start: string, end: string): string {
  if (period === 'day') return fmt.day(start, 'weekdayShort');
  if (period === 'year') return start.slice(0, 4);
  if (period === 'month') return fmt.day(start, 'month');
  return `${fmt.day(start, 'dayShort')} – ${fmt.day(end, 'dayShort')}`;
}

/** Days of a month 'YYYY-MM'. */
export function monthDays(month: string): string[] {
  const out: string[] = [];
  for (let d = `${month}-01`; d.startsWith(month); d = addDays(d, 1)) out.push(d);
  return out;
}

/** Start of an hour of the day in the locale's clock: "07:00" (de) / "07:00 AM" (en-US). */
export const hourLabel = (fmt: Formatter, h: number): string => fmt.time(h * 3600, 0);

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
