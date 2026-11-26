/**
 * Charts of the "similar efforts" card (pure): a value of every similar activity over time, this one highlighted, with
 * a least-squares trend line.
 */
import type { EChartsOption } from 'echarts';
import { itemTooltip, legend, lineSeries, scatterSeries, timeAxis, tooltipHtml, valueAxis } from '@/components/charts/options';
import type { ChartTheme } from '@/components/charts/theme';

export interface Pt {
  id: number;
  x: number; // ms
  y: number;
  current: boolean;
  title: string;
  /** UTC offset (min) of the activity: its local day is the date shown. */
  tzMin: number;
}

/** Point data: [x (ms), y, id, title, tzMin]. */
type Datum = [number, number, number | null, string | null, number];

/** Least squares line through (x, y); null with fewer than 3 points or no spread in x. */
export function linearTrend(pts: { x: number; y: number }[]): { slope: number; intercept: number } | null {
  if (pts.length < 3) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

export function trendChart(
  pts: Pt[],
  theme: ChartTheme,
  o: {
    inverse: boolean;
    format: (v: number) => string;
    names: { others: string; current: string; trend: string };
    /** Local date of an instant at an offset (the activity's own). */
    dateLabel: (ms: number, tzMin: number) => string;
    minInterval?: number;
  },
): EChartsOption {
  const others = pts.filter((p) => !p.current);
  const cur = pts.find((p) => p.current);
  const tr = linearTrend(pts);
  const xs = pts.map((p) => p.x);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  // the trend line's ends lie on the first and the last activity: dated in their time zones
  const tzAt = (x: number) => pts.find((p) => p.x === x)?.tzMin ?? 0;
  const datum = (p: Pt): Datum => [p.x, p.y, p.id, p.title, p.tzMin];
  const tooltip = itemTooltip(theme, (raw: unknown) => {
    const p = raw as { data: Datum; seriesName: string; color: string };
    const date = o.dateLabel(p.data[0], p.data[4]);
    if (p.seriesName === o.names.trend) return tooltipHtml(o.names.trend, [{ color: theme.muted, value: o.format(p.data[1]), label: date }], theme);
    return tooltipHtml(date, [{ color: p.color, value: o.format(p.data[1]), label: p.data[3] ?? '' }], theme);
  });
  return {
    grid: { left: 4, right: 12, top: 34, bottom: 4, containLabel: true },
    legend: legend(theme, 'rect', { data: [o.names.current, o.names.others, o.names.trend] }),
    tooltip,
    xAxis: timeAxis(theme),
    yAxis: valueAxis(theme, {
      inverse: o.inverse,
      scale: true,
      minInterval: o.minInterval,
      axisLabel: { color: theme.muted, fontSize: 11, formatter: o.format },
    }),
    series: [
      scatterSeries(theme, o.names.others, others.map(datum), theme.other, { symbolSize: 8 }),
      ...(tr && x1 > x0
        ? [
            lineSeries(
              theme,
              o.names.trend,
              [
                [x0, tr.intercept + tr.slope * x0, null, null, tzAt(x0)],
                [x1, tr.intercept + tr.slope * x1, null, null, tzAt(x1)],
              ],
              theme.muted,
              { lineStyle: { width: 1.5, color: theme.muted }, silent: false, z: 1 },
            ),
          ]
        : []),
      ...(cur
        ? [
            scatterSeries(theme, o.names.current, [datum(cur)], theme.accent, {
              symbolSize: 14,
              z: 5,
              label: {
                show: true,
                // label towards the middle of the chart so it is never clipped at the edges
                position: x1 > x0 && (cur.x - x0) / (x1 - x0) < 0.5 ? 'right' : 'left',
                distance: 8,
                formatter: o.names.current,
                color: theme.fg,
                fontSize: 11,
                fontWeight: 600,
              },
            }),
          ]
        : []),
    ],
  };
}

