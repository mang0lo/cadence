import type { Formatter } from '@/lib/format';

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

/**
 * ECharts parses 'YYYY-MM-DD' strings on a time axis as local midnight; this turns an axis value (ms) back into the
 * day key so labels can go through `useFormat()` (locale aware) instead of ECharts' built-in English formats.
 */
export function msToDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Axis label formatter for a time axis whose data are 'YYYY-MM-DD' strings. */
export const dayAxisLabel = (fmt: Formatter) => (value: number) => fmt.day(msToDay(value), 'dayShort');

/** Same as `msToDay` for axes whose values are "local wall clock as UTC" milliseconds (charts with `useUTC: true`). */
export function msToDayUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export const dayAxisLabelUtc = (fmt: Formatter) => (value: number) => fmt.day(msToDayUtc(value), 'dayShort');

/** Shared legend overrides: line icons must not inherit the 2 px surface ring of the line series (it would hide them). */
export const LEGEND_LINE_ICON = { itemStyle: { borderWidth: 0 } } as const;
