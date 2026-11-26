import { useCallback, useRef } from 'react';
import type { ECharts } from 'echarts';
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

/** Decimals a tick value needs (2000 → 0, 0.5 → 1, 0.25 → 2; at most 3), ignoring floating-point noise (0.30000000000000004). */
export function tickDigits(v: number): number {
  for (let d = 0; d < 3; d++) {
    const s = v * 10 ** d;
    if (Math.abs(s - Math.round(s)) < 1e-6 * Math.max(1, Math.abs(s))) return d;
  }
  return 3;
}

/**
 * Label formatter for value axes: the ticks ECharts picks, with the separators of the locale ("6.000", "0,5" in German).
 * Without a formatter ECharts writes every number the English way ("6,000" reads as 6 in German).
 */
export const numAxisLabel = (fmt: Formatter) => (value: number) => fmt.num(value, tickDigits(value));

/** Shared legend overrides: line icons must not inherit the 2 px surface ring of the line series (it would hide them). */
export const LEGEND_LINE_ICON = { itemStyle: { borderWidth: 0 } } as const;

/**
 * Click on a category chart (bars per night / day): calls `handler` with the index of the category under the pointer, also
 * when the click lands in the gap between two thin bars. Attached through `onReady`: the shared <EChart onEvents>
 * detaches its handlers after the instance is disposed on unmount, which makes ECharts warn, whereas handlers attached
 * to the instance itself disappear with it.
 */
export function useChartClick(handler: (dataIndex: number) => void): (chart: ECharts) => void {
  const ref = useRef(handler);
  ref.current = handler;
  return useCallback((chart: ECharts) => {
    const zr = chart.getZr();
    const inGrid = (x: number, y: number) => chart.containPixel('grid', [x, y]);
    zr.on('click', (e: { offsetX: number; offsetY: number }) => {
      if (!inGrid(e.offsetX, e.offsetY)) return;
      const v = chart.convertFromPixel({ xAxisIndex: 0 }, e.offsetX);
      const i = Math.round(Array.isArray(v) ? (v[0] as number) : (v as number));
      if (Number.isFinite(i) && i >= 0) ref.current(i);
    });
    zr.on('mousemove', (e: { offsetX: number; offsetY: number }) => {
      zr.setCursorStyle(inGrid(e.offsetX, e.offsetY) ? 'pointer' : 'default');
    });
  }, []);
}
