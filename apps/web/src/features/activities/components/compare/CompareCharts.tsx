import { useMemo, type ReactNode } from 'react';
import { Gauge, HeartPulse, Mountain, Timer, type LucideIcon } from 'lucide-react';
import type { EChartsOption } from 'echarts';
import { M_PER_FT, M_PER_KM, M_PER_MI } from '@cadence/shared';
import { ChartCard, type TableView } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { axisTooltip, legend, lineSeries, tooltipHtml, valueAxis, type TooltipRow } from '@/components/charts/options';
import { useChartTheme, type ChartTheme } from '@/components/charts/theme';
import { clock, useFormat, type Formatter } from '@/lib/format';
import { useI18n, type TFunction } from '@/lib/i18n';
import { gridValue, sideSeries, smoothGrid, type Alignment, type SideSeries } from '../../lib/compare';
import { isPaceSport } from '../../lib/display';
import type { Store } from '../../lib/store';
import { quantile, type Prepared } from '../../lib/streams';
import { SIDE_VAR } from './CompareMap';

type Side = 'a' | 'b';
/** [x, y as drawn (clamped), y as measured] — null y = a gap in the line. */
type Point = [number, number | null, number | null];

/** Fixed plot margins: the x axes of all charts line up. */
const GRID = { left: 56, right: 16, top: 34, bottom: 24, containLabel: false, outerBoundsMode: 'none' as const };

interface Axis {
  /** Grid x in display units: km/mi (distance alignment) or seconds (time alignment). */
  xs: number[];
  max: number;
  label: (v: number) => string;
  /** Tooltip title of a display x. */
  title: (v: number) => string;
  /** Display x → alignment x (m or s). */
  toAlign: (v: number) => number;
}

/** Series points with a gap (null) before the first grid point of every new track part. */
function points(xs: number[], ys: ArrayLike<number>, gaps: number[], conv: (v: number) => number | null): Point[] {
  const at = new Set(gaps);
  const out: Point[] = [];
  for (let k = 0; k < xs.length; k++) {
    const raw = ys[k]!;
    if (k > 0 && at.has(k)) out.push([xs[k]!, null, null]);
    const y = raw === raw ? conv(raw) : null;
    out.push([xs[k]!, y, y === null ? null : raw]);
  }
  return out;
}

function xAxis(theme: ChartTheme, axis: Axis) {
  return {
    type: 'value' as const,
    min: 0,
    max: axis.max,
    axisLine: { lineStyle: { color: theme.axis } },
    axisTick: { show: false },
    axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: axis.label },
    splitLine: { show: false },
  };
}

interface Metric {
  key: 'pace' | 'hr' | 'elevation';
  title: string;
  icon: LucideIcon;
  a: Float64Array | null;
  b: Float64Array | null;
  /** Measured value → drawn value (unit conversion; null hides the point). */
  conv: (v: number) => number | null;
  inverse?: boolean;
  /** Robust bounds in drawn units. */
  bounds: (all: number[]) => { min?: number; max?: number };
  axisLabel: (v: number) => string;
  /** Measured value → text. */
  format: (v: number) => string;
  /** A − B of two measured values → text. */
  diff: (a: number, b: number) => string;
}

function pairOption(theme: ChartTheme, axis: Axis, m: Metric, al: Alignment, names: Record<Side, string>, diffLabel: string): EChartsOption {
  const series = [];
  const drawn: number[] = [];
  const side = (s: Side) => {
    const ys = s === 'a' ? m.a : m.b;
    if (!ys) return null;
    const pts = points(axis.xs, ys, s === 'a' ? al.breaksA : al.breaksB, m.conv);
    for (const p of pts) if (p[1] !== null) drawn.push(p[1]);
    return pts;
  };
  const pa = side('a');
  const pb = side('b');
  const finite = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : undefined);
  const b = m.bounds(drawn);
  const min = finite(b.min);
  const max = finite(b.max);
  const clamp = (pts: Point[]): Point[] =>
    pts.map(([x, y, raw]) => [x, y === null ? null : Math.min(max ?? Infinity, Math.max(min ?? -Infinity, y)), raw]);
  if (pa) series.push(lineSeries(theme, names.a, clamp(pa), theme.series[0]!, { connectNulls: false, lineStyle: { width: 1.75, color: theme.series[0]! } }));
  if (pb) series.push(lineSeries(theme, names.b, clamp(pb), theme.series[1]!, { connectNulls: false, lineStyle: { width: 1.75, color: theme.series[1]! } }));
  return {
    animation: false,
    grid: GRID,
    legend: legend(theme, 'line', { data: [pa && names.a, pb && names.b].filter(Boolean) }),
    tooltip: axisTooltip(theme, (raw: unknown) => {
      const ps = raw as { seriesName: string; color: string; value: Point }[];
      if (!ps.length) return '';
      const rows: TooltipRow[] = [];
      let va: number | null = null;
      let vb: number | null = null;
      for (const p of ps) {
        const v = p.value[2];
        if (v === null || v === undefined) continue;
        const isA = p.seriesName === names.a;
        if (isA) va = v;
        else vb = v;
        rows.push({ color: isA ? theme.series[0]! : theme.series[1]!, value: m.format(v), label: p.seriesName });
      }
      if (va !== null && vb !== null) rows.push({ color: theme.muted, value: m.diff(va, vb), label: diffLabel });
      return rows.length ? tooltipHtml(axis.title(ps[0]!.value[0]), rows, theme) : '';
    }),
    xAxis: xAxis(theme, axis),
    yAxis: valueAxis(theme, {
      min,
      max,
      inverse: !!m.inverse,
      splitNumber: 3,
      axisLabel: { color: theme.muted, fontSize: 11, formatter: m.axisLabel, showMinLabel: min === undefined, showMaxLabel: max === undefined },
    }),
    series,
  } as EChartsOption;
}

function gapOption(theme: ChartTheme, axis: Axis, al: Alignment, t: TFunction, name: string): EChartsOption {
  const data = points(axis.xs, al.gap!, [...new Set([...al.breaksA, ...al.breaksB])], (v) => v);
  // finite piece bounds: with only open-ended pieces ECharts has no gradient stops for the line (and throws)
  let lo = 0;
  let hi = 0;
  for (const v of al.gap!) if (v === v) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
  const lead = (g: number) =>
    Math.abs(g) < 0.5 ? t('activities.compare.level') : t('activities.compare.ahead', { name: g > 0 ? 'A' : 'B' });
  return {
    animation: false,
    grid: { ...GRID, top: 12 },
    tooltip: axisTooltip(theme, (raw: unknown) => {
      const p = (raw as { value: Point }[])[0];
      const g = p?.value[2];
      if (!p || g === null || g === undefined) return '';
      return tooltipHtml(
        axis.title(p.value[0]),
        [{ color: g >= 0 ? theme.series[0]! : theme.series[1]!, value: Math.abs(g) < 0.5 ? '0:00' : clock(Math.abs(g)), label: lead(g) }],
        theme,
      );
    }),
    // above zero A's color (A ahead), below B's: the area says who leads, the sign is the axis side
    visualMap: {
      show: false,
      type: 'piecewise',
      dimension: 1,
      seriesIndex: 0,
      pieces: [
        { gte: lo - 1, lt: 0, color: theme.series[1]! },
        { gte: 0, lte: hi + 1, color: theme.series[0]! },
      ],
    },
    xAxis: xAxis(theme, axis),
    yAxis: valueAxis(theme, {
      splitNumber: 4,
      axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => (v === 0 ? '0' : clock(Math.abs(v))) },
    }),
    series: [
      {
        type: 'line',
        name,
        data,
        showSymbol: false,
        symbol: 'none',
        connectNulls: false,
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.14 },
        emphasis: { disabled: true },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: theme.axis, width: 1, type: 'solid' },
          data: [{ yAxis: 0 }],
        },
      },
    ],
  } as EChartsOption;
}

/** Table rows per km / mi (per ¼ when shorter than 2), or per 5 minutes in time alignment. */
function intervals(al: Alignment, fmt: Formatter, unitM: number): { a: number; b: number; label: string }[] {
  const out: { a: number; b: number; label: string }[] = [];
  if (al.mode === 'distance') {
    const step = al.span >= 2 * unitM ? unitM : unitM / 4;
    for (let a = 0; a < al.span - 1 && out.length < 400; a += step) {
      const b = Math.min(al.span, a + step);
      const v = b / unitM;
      out.push({ a, b, label: `${fmt.num(v, Number.isInteger(Math.round(v * 1e6) / 1e6) ? 0 : 2)} ${fmt.distanceUnit}` });
    }
  } else {
    for (let a = 0; a < al.span - 1 && out.length < 400; a += 300) {
      const b = Math.min(al.span, a + 300);
      out.push({ a, b, label: `${clock(a)}–${clock(b)}` });
    }
  }
  return out;
}

/** Mean of a grid series over [a, b] (alignment units). */
function meanBetween(al: Alignment, ys: Float64Array, a: number, b: number): number {
  let s = 0;
  let c = 0;
  for (let k = 0; k < al.x.length; k++) {
    const x = al.x[k]!;
    if (x < a || x > b) continue;
    const v = ys[k]!;
    if (v === v) {
      s += v;
      c++;
    }
  }
  return c ? s / c : NaN;
}

function SideKey({ side, children }: { side: Side; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-3 shrink-0 rounded-sm" style={{ background: SIDE_VAR[side] }} aria-hidden />
      {children}
    </span>
  );
}

export interface CompareChartsProps {
  A: Prepared;
  B: Prepared;
  al: Alignment;
  sport: string;
  hover: Store<number | null>;
  names: Record<Side, string>;
}

/**
 * The time gap over the distance (who was ahead where) and pace / heart rate / elevation of both on one axis per chart,
 * each with its table view. Hovering a chart shows both positions on the map.
 */
export function CompareCharts({ A, B, al, sport, hover, names }: CompareChartsProps) {
  const { t } = useI18n();
  const fmt = useFormat();
  const theme = useChartTheme();
  const imperial = fmt.units === 'imperial';
  const unitM = imperial ? M_PER_MI : M_PER_KM;
  const dist = al.mode === 'distance';

  // pace over ~50 m (10 s on the clock): raw 5 m bins are too jittery to compare two lines
  const smoothed = (s: SideSeries, breaks: number[]): SideSeries => {
    const step = al.x.length > 1 ? al.x[1]! - al.x[0]! : 1;
    const half = Math.max(1, Math.round((dist ? 25 : 5) / step));
    return { ...s, speed: s.speed && smoothGrid(s.speed, half, breaks) };
  };
  const sa = useMemo<SideSeries>(() => smoothed(sideSeries(A, al, 'a'), al.breaksA), [A, al]); // eslint-disable-line react-hooks/exhaustive-deps
  const sb = useMemo<SideSeries>(() => smoothed(sideSeries(B, al, 'b'), al.breaksB), [B, al]); // eslint-disable-line react-hooks/exhaustive-deps

  const axis = useMemo<Axis>(() => {
    const xs = Array.from(al.x, (v) => (dist ? v / unitM : v));
    const max = xs[xs.length - 1]!;
    return {
      xs,
      max,
      label: dist ? (v: number) => fmt.num(v, max < 10 ? 1 : 0) : (v: number) => clock(v),
      title: dist ? (v: number) => fmt.distance(v * unitM, 2) : (v: number) => clock(v),
      toAlign: dist ? (v: number) => v * unitM : (v: number) => v,
    };
  }, [al, dist, unitM, fmt]);

  const metrics = useMemo<Metric[]>(() => {
    const out: Metric[] = [];
    const signed = (v: number, text: string) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${text}`;
    if (sa.speed || sb.speed) {
      const pace = isPaceSport(sport);
      const unitP = sport === 'swim' ? (imperial ? 91.44 : 100) : unitM;
      const conv = (mps: number) => (mps > 0.3 ? (pace ? unitP / mps : imperial ? mps / (M_PER_MI / 3600) : mps * 3.6) : null);
      const unit = fmt.paceParts(1, sport).unit;
      out.push({
        key: 'pace',
        title: pace ? t('activities.compare.charts.pace') : t('activities.compare.charts.speed'),
        icon: Gauge,
        a: sa.speed,
        b: sb.speed,
        conv,
        inverse: pace,
        bounds: (all) => {
          const lo = quantile(all, pace ? 0.02 : 0);
          const hi = quantile(all, pace ? 0.98 : 0.995);
          const pad = (hi - lo) * 0.08 || 10;
          return { min: pace ? Math.max(0, lo - pad) : 0, max: hi + pad };
        },
        axisLabel: (v) => (pace ? clock(v) : fmt.num(v)),
        format: (mps) => fmt.pace(mps, sport),
        diff: (a, b) => {
          const d = conv(a)! - conv(b)!;
          return pace ? `${signed(Math.round(d), clock(Math.abs(d)))} ${unit}` : `${fmt.signed(d, 1)} ${unit}`;
        },
      });
    }
    if (sa.hr || sb.hr) {
      out.push({
        key: 'hr',
        title: t('activities.compare.charts.hr'),
        icon: HeartPulse,
        a: sa.hr,
        b: sb.hr,
        conv: (v) => v,
        bounds: (all) => ({
          min: Math.floor((quantile(all, 0) - 5) / 5) * 5,
          max: Math.ceil((quantile(all, 1) + 5) / 5) * 5,
        }),
        axisLabel: (v) => fmt.num(v),
        format: (v) => fmt.hr(v),
        diff: (a, b) => `${fmt.signed(a - b)} bpm`,
      });
    }
    if (sa.ele || sb.ele) {
      const k = imperial ? 1 / M_PER_FT : 1;
      out.push({
        key: 'elevation',
        title: t('activities.compare.charts.elevation'),
        icon: Mountain,
        a: sa.ele,
        b: sb.ele,
        conv: (v) => v * k,
        bounds: (all) => {
          const lo = quantile(all, 0);
          const hi = quantile(all, 1);
          const pad = Math.max(5, (hi - lo) * 0.12);
          return { min: Math.floor(lo - pad), max: Math.ceil(hi + pad) };
        },
        axisLabel: (v) => fmt.num(v),
        format: (v) => fmt.elevation(v),
        diff: (a, b) => `${a - b > 0 ? '+' : a - b < 0 ? '−' : '±'}${fmt.elevation(Math.abs(a - b))}`,
      });
    }
    return out;
  }, [sa, sb, sport, imperial, unitM, fmt, t]);

  const options = useMemo(
    () => metrics.map((m) => pairOption(theme, axis, m, al, names, t('activities.compare.charts.difference'))),
    [metrics, theme, axis, al, names, t],
  );
  const gap = useMemo(() => (al.gap ? gapOption(theme, axis, al, t, t('activities.compare.gap.title')) : null), [al, theme, axis, t]);

  const rows = useMemo(() => intervals(al, fmt, unitM), [al, fmt, unitM]);
  const tables = useMemo(() => {
    const leadText = (g: number) =>
      Math.abs(g) < 0.5
        ? t('activities.compare.level')
        : t('activities.compare.aheadBy', { name: g > 0 ? 'A' : 'B', value: clock(Math.abs(g)) });
    const xLabel = dist ? t('activities.compare.table.distance') : t('activities.compare.table.time');
    const cols = (label: string) => [
      { key: 'x', label: xLabel },
      { key: 'a', label: `${label} A`, numeric: true },
      { key: 'b', label: `${label} B`, numeric: true },
      { key: 'd', label: t('activities.compare.table.difference'), numeric: true },
    ];
    const gapTable: TableView | null =
      al.tA && al.tB && al.gap
        ? {
            columns: [
              { key: 'x', label: xLabel },
              { key: 'a', label: `${t('activities.compare.table.time')} A`, numeric: true },
              { key: 'b', label: `${t('activities.compare.table.time')} B`, numeric: true },
              { key: 'd', label: t('activities.compare.table.gap'), numeric: true },
            ],
            rows: rows.map((r) => ({
              x: r.label,
              a: clock(gridValue(al, al.tA!, r.b)),
              b: clock(gridValue(al, al.tB!, r.b)),
              d: leadText(gridValue(al, al.gap!, r.b)),
            })),
          }
        : null;
    const metricTables = metrics.map<TableView>((m) => ({
      columns: cols(m.title),
      rows: rows.map((r) => {
        // pace per split from the clock (exact), elevation at the split's end, everything else the mean
        const value = (s: Side): number => {
          const ys = s === 'a' ? m.a : m.b;
          if (!ys) return NaN;
          if (m.key === 'pace' && dist) {
            const ts = s === 'a' ? al.tA! : al.tB!;
            const dt = gridValue(al, ts, r.b) - gridValue(al, ts, r.a);
            return dt > 0 ? (r.b - r.a) / dt : NaN;
          }
          if (m.key === 'elevation') return gridValue(al, ys, r.b);
          return meanBetween(al, ys, r.a, r.b);
        };
        const va = value('a');
        const vb = value('b');
        return {
          x: r.label,
          a: va === va ? m.format(va) : '–',
          b: vb === vb ? m.format(vb) : '–',
          d: va === va && vb === vb ? m.diff(va, vb) : '–',
        };
      }),
    }));
    return { gapTable, metricTables };
  }, [al, rows, metrics, dist, t]);

  const onEvents = useMemo(
    () => ({
      updateAxisPointer: (e: { axesInfo?: { value?: number }[] }) => {
        const v = e.axesInfo?.[0]?.value;
        hover.set(typeof v === 'number' && dist ? axis.toAlign(v) : null);
      },
      globalout: () => hover.set(null),
    }),
    [hover, dist, axis],
  );

  const finalGap = al.gap ? al.gap[al.gap.length - 1]! : null;
  const over = dist ? t('activities.compare.charts.over') : t('activities.compare.charts.overTime');

  return (
    <div className="grid min-w-0 gap-4">
      {gap && tables.gapTable && finalGap !== null && (
        <ChartCard
          title={t('activities.compare.gap.title')}
          subtitle={t('activities.compare.gap.final', {
            distance: fmt.distance(al.span),
            text:
              Math.abs(finalGap) < 0.5
                ? t('activities.compare.level')
                : t('activities.compare.aheadBy', { name: finalGap > 0 ? 'A' : 'B', value: clock(Math.abs(finalGap)) }),
          })}
          icon={Timer}
          table={tables.gapTable}
          footer={t('activities.compare.gap.hint')}
        >
          <div className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-2">
            <SideKey side="a">{t('activities.compare.gap.above', { name: 'A' })}</SideKey>
            <SideKey side="b">{t('activities.compare.gap.below', { name: 'B' })}</SideKey>
          </div>
          <EChart option={gap} height={220} ariaLabel={t('activities.compare.gap.title')} onEvents={onEvents} />
        </ChartCard>
      )}
      {metrics.map((m, i) => (
        <ChartCard key={m.key} title={m.title} subtitle={over} icon={m.icon} table={tables.metricTables[i]}>
          <EChart option={options[i]!} height={210} ariaLabel={m.title} onEvents={onEvents} />
        </ChartCard>
      ))}
    </div>
  );
}
