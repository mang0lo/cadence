/**
 * Chart helpers of the progress feature (on top of components/charts/options.ts).
 *
 * Time axes run with `useUTC: true`: days are passed as UTC midnight and workout times as their local
 * wall clock shifted into UTC, so labels never move by a day in the viewer's time zone.
 */
import type { ScatterSeriesOption } from 'echarts';
import { legend } from '@/components/charts/options';
import type { ChartTheme } from '@/components/charts/theme';
import type { DateStyle, Formatter } from '@/lib/format';
import { sportColor } from '@/components/charts/theme';
import { sortSports, sportLabel, sportSlot } from '@/lib/sports';
import type { Lang } from '@/lib/i18n';

export const DAY_MS = 86_400_000;

/** UTC-midnight milliseconds of a 'YYYY-MM-DD' day. */
export function dayMs(day: string): number {
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
}

/** Local wall clock of a workout as UTC milliseconds. */
export function localMs(ts: number, tzMin: number): number {
  return (ts + tzMin * 60) * 1000;
}

/** 'YYYY-MM-DD' of UTC milliseconds. */
export function msDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Both ends of a series' fitted trend on the local time axis. The fit runs from the series' first to its last
 * workout (fit.startTs / endTs are their UTC start times); each end takes that workout's own UTC offset, which
 * differs across DST or travel. Without it a run on Jan 31 at 19:30 in New York would start the trend in February.
 */
export function fitEnds(
  workouts: readonly { tzMin: number }[],
  points: readonly (readonly [number, number])[],
  fit: { startTs: number; endTs: number },
): [number, number] {
  return [localMs(fit.startTs, workouts[points[0]![0]]!.tzMin), localMs(fit.endTs, workouts[points[points.length - 1]![0]]!.tzMin)];
}

/**
 * Time-axis label formatter (UTC based, localized): days for short spans; for long spans month ticks show the
 * month, January shows the year.
 */
export function timeAxisLabel(fmt: Formatter, spanDays: number): (v: number) => string {
  return (v: number) => {
    const d = msDay(v);
    if (spanDays <= 150) return fmt.day(d, 'dayShort' satisfies DateStyle);
    return d.slice(5, 7) === '01' ? d.slice(0, 4) : fmt.day(d, 'monthShort');
  };
}

/** Label of a bucket key ('YYYY-MM-DD' week start, 'YYYY-MM', 'YYYY'). */
export function bucketLabel(fmt: Formatter, key: string, style: 'short' | 'long' = 'short'): string {
  if (key.length === 4) return key;
  // 'monthYear' ("Jan 2026"): 'monthYearShort' would print "Jan 26", which reads like a date
  if (key.length === 7) return fmt.day(`${key}-01`, style === 'short' ? 'monthYear' : 'month');
  return fmt.day(key, style === 'short' ? 'dayShort' : 'day');
}

/**
 * Invisible scatter on top of the visible dots: a ≥ 24 px hit target per point so tooltips do not need
 * pixel-perfect aim. Exclude it from the legend (legend.data lists the visible series only).
 */
export function hitLayer(name: string, data: ScatterSeriesOption['data']): ScatterSeriesOption {
  return {
    type: 'scatter',
    name,
    data,
    symbolSize: 24,
    itemStyle: { color: 'rgba(0,0,0,0)', borderWidth: 0 },
    emphasis: { disabled: true },
    z: 10,
  };
}

/**
 * Sports grouped by chart color: sports sharing a palette slot (e.g. strength + HIIT both "gym") form one
 * series so a legend never shows two entries with the same color. Canonical (palette) order.
 */
export interface SportGroup {
  key: string;
  sports: string[];
  label: string;
  color: string;
}

export function sportGroups(theme: ChartTheme, sports: string[], lang: Lang, otherLabel: string): SportGroup[] {
  const groups = new Map<number, string[]>();
  for (const s of sortSports(sports)) {
    const slot = sportSlot(s);
    const list = groups.get(slot) ?? [];
    list.push(s);
    groups.set(slot, list);
  }
  return [...groups.entries()].map(([slot, list]) => ({
    key: `slot-${slot}`,
    sports: list,
    label: slot === 0 && list.length > 2 ? otherLabel : list.map((s) => sportLabel(s, lang)).join(' · '),
    color: sportColor(theme, list[0]!),
  }));
}

/** Nice symmetric padding for a value axis (min/max functions for ECharts). */
export function paddedExtent(pad = 0.08) {
  return {
    min: (v: { min: number; max: number }) => v.min - (v.max - v.min) * pad,
    max: (v: { min: number; max: number }) => v.max + (v.max - v.min) * pad,
  };
}

/** Index of the point closest to `x` in an ascending array. */
export function nearestIndex(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(xs[lo - 1]! - x) <= Math.abs(xs[lo]! - x)) return lo - 1;
  return lo;
}

/**
 * legend() without the item border: line series carry a 2px surface-colored marker ring in their itemStyle,
 * which ECharts also applies to the legend icon and thereby hides the thin line key.
 */
export function chartLegend(theme: ChartTheme, kind: 'line' | 'rect' = 'rect', extra?: Record<string, unknown>) {
  return legend(theme, kind, { itemStyle: { borderWidth: 0 }, ...extra });
}

const CLOCK_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600, 7200, 10800, 18000, 36000];

/**
 * Value-axis settings for clock values (seconds shown as m:ss / h:mm:ss): ticks on round clock steps
 * (0:30, 1:00, 5:00 …) instead of decimal steps like 3:20.
 */
export function clockAxis(
  values: readonly number[],
  targetTicks = 5,
  /** Minimum visible span in seconds, so a 1 s wobble does not fill the whole chart. */
  minSpan = 0,
): { min: number; max: number; interval: number } | Record<string, never> {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return {};
  let lo = Math.min(...finite);
  let hi = Math.max(...finite);
  if (hi - lo < minSpan) {
    const mid = (lo + hi) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  const span = Math.max(hi - lo, 1);
  const interval = CLOCK_STEPS.find((s) => span / s <= targetTicks) ?? CLOCK_STEPS.at(-1)!;
  const min = Math.floor(lo / interval) * interval;
  let max = Math.ceil(hi / interval) * interval;
  if (max === min) max = min + interval;
  return { min, max, interval };
}
