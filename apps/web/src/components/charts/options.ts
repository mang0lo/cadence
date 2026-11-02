/**
 * ECharts option builders that encode the house chart style (dataviz rules):
 *  - lines 2px, round caps; markers ≥ 8px with a 2px surface ring
 *  - bars ≤ 24px thick, 4px rounded data end, square at the baseline, 2px surface gap in stacks
 *  - area fills are a ~10% wash; gridlines solid hairlines; axes recessive
 *  - ONE y-axis per chart (never dual axis) — use two charts instead
 *  - tooltips: values lead, labels follow, short line keys; names are HTML-escaped
 */
import type { EChartsOption, BarSeriesOption, LineSeriesOption, ScatterSeriesOption } from 'echarts';
import type { ChartTheme } from './theme';

type AnyObj = Record<string, unknown>;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Base grid: room for labels, no wasted chrome. */
export function grid(extra?: AnyObj): AnyObj {
  return { left: 4, right: 12, top: 16, bottom: 4, containLabel: true, ...extra };
}

export function timeAxis(t: ChartTheme, extra?: AnyObj): AnyObj {
  return {
    type: 'time',
    axisLine: { lineStyle: { color: t.axis, width: 1 } },
    axisTick: { show: false },
    axisLabel: { color: t.muted, hideOverlap: true, fontSize: 11 },
    splitLine: { show: false },
    ...extra,
  };
}

export function categoryAxis(t: ChartTheme, data: (string | number)[], extra?: AnyObj): AnyObj {
  return {
    type: 'category',
    data,
    axisLine: { lineStyle: { color: t.axis, width: 1 } },
    axisTick: { show: false },
    axisLabel: { color: t.muted, hideOverlap: true, fontSize: 11 },
    splitLine: { show: false },
    ...extra,
  };
}

export function valueAxis(t: ChartTheme, extra?: AnyObj): AnyObj {
  return {
    type: 'value',
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: t.muted, fontSize: 11 },
    splitLine: { lineStyle: { color: t.grid, width: 1, type: 'solid' } },
    splitNumber: 4,
    ...extra,
  };
}

const tooltipBase = (t: ChartTheme): AnyObj => ({
  backgroundColor: t.surface,
  borderColor: t.border,
  borderWidth: 1,
  padding: [8, 10],
  textStyle: { color: t.fg, fontSize: 12, fontFamily: t.font },
  extraCssText: 'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.14);',
  confine: true,
});

/** Crosshair tooltip for line/area/time charts (lists every series at that x). */
export function axisTooltip(t: ChartTheme, formatter?: (params: unknown) => string, extra?: AnyObj): AnyObj {
  return {
    ...tooltipBase(t),
    trigger: 'axis',
    axisPointer: { type: 'line', lineStyle: { color: t.axis, width: 1 }, snap: true },
    ...(formatter ? { formatter } : {}),
    ...extra,
  };
}

/** Per-mark tooltip for bars, dots and cells. */
export function itemTooltip(t: ChartTheme, formatter?: (params: unknown) => string, extra?: AnyObj): AnyObj {
  return { ...tooltipBase(t), trigger: 'item', ...(formatter ? { formatter } : {}), ...extra };
}

export interface TooltipRow {
  color: string;
  label: string;
  value: string;
}

/** Tooltip HTML: optional title, then rows of [line key] value · label (value leads). */
export function tooltipHtml(title: string | null, rows: TooltipRow[], t: ChartTheme): string {
  const head = title ? `<div style="color:${t.muted};font-size:11px;margin-bottom:4px">${escapeHtml(title)}</div>` : '';
  const body = rows
    .map(
      (r) =>
        `<div style="display:flex;align-items:center;gap:8px;line-height:18px">` +
        `<span style="display:inline-block;width:10px;height:2px;border-radius:1px;background:${r.color}"></span>` +
        `<span style="font-weight:600;color:${t.fg}">${escapeHtml(r.value)}</span>` +
        `<span style="color:${t.fg2}">${escapeHtml(r.label)}</span></div>`,
    )
    .join('');
  return head + body;
}

export function lineSeries(
  t: ChartTheme,
  name: string,
  data: LineSeriesOption['data'],
  color: string,
  extra?: Partial<LineSeriesOption>,
): LineSeriesOption {
  return {
    type: 'line',
    name,
    data,
    showSymbol: false,
    symbol: 'circle',
    symbolSize: 8,
    smooth: false,
    lineStyle: { width: 2, color, cap: 'round', join: 'round' },
    itemStyle: { color, borderColor: t.surface, borderWidth: 2 },
    emphasis: { disabled: true },
    ...extra,
  };
}

export function areaSeries(
  t: ChartTheme,
  name: string,
  data: LineSeriesOption['data'],
  color: string,
  extra?: Partial<LineSeriesOption>,
): LineSeriesOption {
  return lineSeries(t, name, data, color, { areaStyle: { color, opacity: 0.1 }, ...extra });
}

export function barSeries(
  t: ChartTheme,
  name: string,
  data: BarSeriesOption['data'],
  color: string,
  extra?: Partial<BarSeriesOption> & { horizontal?: boolean },
): BarSeriesOption {
  const { horizontal, ...rest } = extra ?? {};
  return {
    type: 'bar',
    name,
    data,
    barMaxWidth: 24,
    itemStyle: {
      color,
      borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
      borderColor: t.surface,
      borderWidth: 1,
    },
    emphasis: { itemStyle: { color, opacity: 0.85 } },
    ...rest,
  };
}

/**
 * Stacked bars: pass series bottom→top in canonical (palette) order. Only the top series gets the
 * rounded data end; a 1px surface border on each segment yields the 2px gap between segments.
 */
export function stackedBarSeries(
  t: ChartTheme,
  stack: string,
  series: { name: string; data: BarSeriesOption['data']; color: string }[],
): BarSeriesOption[] {
  return series.map((s, i) =>
    barSeries(t, s.name, s.data, s.color, {
      stack,
      itemStyle: {
        color: s.color,
        borderColor: t.surface,
        borderWidth: 1,
        borderRadius: i === series.length - 1 ? [4, 4, 0, 0] : 0,
      },
    }),
  );
}

export function scatterSeries(
  t: ChartTheme,
  name: string,
  data: ScatterSeriesOption['data'],
  color: string,
  extra?: Partial<ScatterSeriesOption>,
): ScatterSeriesOption {
  return {
    type: 'scatter',
    name,
    data,
    symbolSize: 8,
    itemStyle: { color, borderColor: t.surface, borderWidth: 2, opacity: 0.9 },
    emphasis: { scale: 1.4 },
    ...extra,
  };
}

/** Legend (always present for ≥ 2 series). Line icons for line charts, rects for bars. */
export function legend(t: ChartTheme, kind: 'line' | 'rect' = 'rect', extra?: AnyObj): AnyObj {
  return {
    show: true,
    top: 0,
    left: 0,
    icon: kind === 'line' ? 'path://M0,4 L14,4 L14,6 L0,6 Z' : 'roundRect',
    itemWidth: kind === 'line' ? 14 : 10,
    itemHeight: kind === 'line' ? 4 : 10,
    itemGap: 14,
    // line series draw their symbols with a surface-colored border; it would hide the thin legend keys
    itemStyle: { borderWidth: 0 },
    textStyle: { color: t.fg2, fontSize: 12 },
    ...extra,
  };
}

/** Zoom slider/inside for long time series. */
export function dataZoom(t: ChartTheme, opts: { slider?: boolean } = {}): AnyObj[] {
  const inside = { type: 'inside', throttle: 50 };
  if (!opts.slider) return [inside];
  return [
    inside,
    {
      type: 'slider',
      height: 18,
      bottom: 4,
      borderColor: 'transparent',
      backgroundColor: t.cellEmpty,
      fillerColor: 'rgba(128,128,128,0.15)',
      dataBackground: { lineStyle: { color: t.axis }, areaStyle: { color: t.grid } },
      handleStyle: { color: t.surface, borderColor: t.axis },
      textStyle: { color: t.muted },
      moveHandleSize: 0,
    },
  ];
}

/** Common top-level defaults merged by <EChart>. */
export function baseOption(t: ChartTheme): EChartsOption {
  return {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: t.font, color: t.fg2 },
    animationDuration: 350,
    animationDurationUpdate: 250,
    grid: grid(),
  };
}
