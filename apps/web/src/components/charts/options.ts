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

// ---------------------------------------------------------------------------------------------------------------------
// Locale: ECharts formats numbers as "1,234.5" and names months in English whatever the page language. <EChart>
// applies these, so every chart is locale-correct without each option having to remember it.

const axisFormatters = new Map<string, (v: number) => string>();

/** Default label of numeric axes in the user's number format (as many decimals as the tick has, no "-0"). */
export function axisNumberFormatter(locale: string): (v: number) => string {
  let f = axisFormatters.get(locale);
  if (!f) {
    const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 });
    f = (v: number) => nf.format(v === 0 ? 0 : v);
    axisFormatters.set(locale, f);
  }
  return f;
}

type AxisOption = { type?: string; axisLabel?: { formatter?: unknown } };

const NUMERIC_AXES = new Set(['value', 'log']);

function localizeAxis(axis: unknown, defaultType: string, format: (v: number) => string): unknown {
  if (!axis || typeof axis !== 'object') return axis;
  const a = axis as AxisOption;
  if (!NUMERIC_AXES.has(a.type ?? defaultType) || a.axisLabel?.formatter != null) return axis;
  return { ...a, axisLabel: { ...a.axisLabel, formatter: format } };
}

/**
 * Value and log axes without a label formatter of their own get `format` (ECharts' default x axis is a category
 * axis, its default y axis a value axis). Returns a new option; the given one is not changed.
 */
export function localizeAxes(option: EChartsOption, format: (v: number) => string): EChartsOption {
  const fix = (axes: unknown, defaultType: string) =>
    Array.isArray(axes) ? axes.map((a) => localizeAxis(a, defaultType, format)) : localizeAxis(axes, defaultType, format);
  const out: EChartsOption = { ...option };
  if (option.xAxis !== undefined) out.xAxis = fix(option.xAxis, 'category') as EChartsOption['xAxis'];
  if (option.yAxis !== undefined) out.yAxis = fix(option.yAxis, 'value') as EChartsOption['yAxis'];
  return out;
}

export interface ChartLocale {
  time: { month: string[]; monthAbbr: string[]; dayOfWeek: string[]; dayOfWeekAbbr: string[] };
}

const chartLocales = new Map<string, ChartLocale>();

/**
 * ECharts locale with the month and weekday names of the user's language (time axis labels such as "Mär" or "Nov";
 * ECharts' own are English). Missing parts fall back to ECharts' English texts.
 */
export function chartLocale(locale: string): ChartLocale {
  let l = chartLocales.get(locale);
  if (!l) {
    const names = (opts: Intl.DateTimeFormatOptions, dates: number[]) => {
      const f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' });
      return dates.map((d) => f.format(new Date(d)));
    };
    const months = Array.from({ length: 12 }, (_, i) => Date.UTC(2024, i, 1));
    // ECharts counts weekdays from Sunday; 2024-01-07 is a Sunday
    const days = Array.from({ length: 7 }, (_, i) => Date.UTC(2024, 0, 7 + i));
    l = {
      time: {
        month: names({ month: 'long' }, months),
        monthAbbr: names({ month: 'short' }, months),
        dayOfWeek: names({ weekday: 'long' }, days),
        dayOfWeekAbbr: names({ weekday: 'short' }, days),
      },
    };
    chartLocales.set(locale, l);
  }
  return l;
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
