import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Activity } from 'lucide-react';
import type { LineSeriesOption } from 'echarts';
import { M_PER_FT, M_PER_KM, M_PER_MI } from '@cadence/shared';
import { ChartCard, type TableView } from '@/components/charts/ChartCard';
import { EChart, pointerInElement } from '@/components/charts/EChart';
import { valueAxis } from '@/components/charts/options';
import { useChartTheme, type ChartTheme } from '@/components/charts/theme';
import { SegmentedControl } from '@/components/ui';
import { clock, useFormat, type Formatter } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { TFunction } from '@/lib/i18n';
import { useStoredState } from '@/lib/storage';
import { isPaceSport } from '../../lib/display';
import type { Playback } from '../../lib/playback';
import type { Store } from '../../lib/store';
import {
  bucketMean,
  bucketMoving,
  buckets,
  fracIndex,
  indexAtTime,
  quantile,
  valueAt,
  type Buckets,
  type Prepared,
} from '../../lib/streams';

/** Fixed plot margins so every chart maps x to the same pixels (overlays span the whole stack). */
const GL = 46;
const GR = 12;

export type XMode = 'dist' | 'time';
type MetricKey = 'elevation' | 'pace' | 'hr' | 'cadence' | 'power';

interface Metric {
  key: MetricKey;
  label: string;
  color: string;
  y: (number | null)[];
  min?: number;
  max?: number;
  inverse?: boolean;
  area?: boolean;
  bands?: { from: number; to: number; color: string; label: string }[];
  /** Readout of a full-resolution fractional index. */
  readout: (fi: number) => string;
  axis: (v: number) => string;
  /** Summary shown while nothing is hovered (prefixed with "avg" unless it is a range). */
  avg: string;
  avgIsRange?: boolean;
  height: number;
}

const finite = (v: number) => (Number.isFinite(v) ? v : null);

function buildMetrics(
  P: Prepared,
  B: Buckets,
  sport: string,
  zoneBounds: number[],
  theme: ChartTheme,
  fmt: Formatter,
  t: TFunction,
): Metric[] {
  const out: Metric[] = [];
  const imperial = fmt.units === 'imperial';
  const moving = bucketMoving(P, B);
  if (P.ele) {
    const k = imperial ? 1 / M_PER_FT : 1;
    const e = bucketMean(P.ele, B);
    const lo = quantile(e, 0);
    const hi = quantile(e, 1);
    const pad = Math.max(5, (hi - lo) * 0.12);
    out.push({
      key: 'elevation',
      label: t('activities.charts.elevation'),
      color: theme.other,
      y: Array.from(e, (v) => finite(v * k)),
      min: Math.floor((lo - pad) * k),
      area: true,
      readout: (fi) => fmt.elevation(valueAt(P.ele, fi)),
      axis: (v) => fmt.num(v),
      avg: `${fmt.elevation(lo)} – ${fmt.elevation(hi)}`,
      avgIsRange: true,
      height: 92,
    });
  }
  if (P.speed && P.dist) {
    const pace = isPaceSport(sport);
    const s = bucketMean(P.speed, B);
    const unitM = sport === 'swim' ? (imperial ? 91.44 : 100) : imperial ? M_PER_MI : M_PER_KM;
    const conv = (mps: number) => (pace ? unitM / mps : imperial ? mps / (M_PER_MI / 3600) : mps * 3.6);
    const vals = Array.from(s, (v, b) => (v > 0.3 && moving[b]! >= 0.5 ? conv(v) : NaN));
    const lo = quantile(vals, pace ? 0.02 : 0);
    const hi = quantile(vals, pace ? 0.98 : 0.995);
    const pad = (hi - lo) * 0.08 || 10;
    const min = pace ? Math.max(0, lo - pad) : 0;
    const max = hi + pad;
    const total = P.totalDist;
    let movingS = 0;
    for (let i = 1; i < P.n; i++) if (P.moving[i]) movingS += Math.min(600, P.t[i]! - P.t[i - 1]!);
    out.push({
      key: 'pace',
      label: pace ? t('activities.charts.pace') : t('activities.charts.speed'),
      color: theme.series[1]!,
      y: vals.map((v) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null)),
      min,
      max,
      inverse: pace,
      readout: (fi) => {
        const moving = P.moving[Math.min(P.n - 1, Math.ceil(fi))];
        return fmt.pace(moving ? valueAt(P.speed, fi) : null, sport);
      },
      axis: (v) => (pace ? clock(v) : fmt.num(v)),
      avg: fmt.pace(movingS > 0 ? total / movingS : null, sport),
      height: 84,
    });
  }
  if (P.hr) {
    const h = bucketMean(P.hr, B);
    const lo = quantile(h, 0);
    const hi = quantile(h, 1);
    const min = Math.floor((lo - 5) / 5) * 5;
    const max = Math.ceil((hi + 5) / 5) * 5;
    const edges = [0, ...zoneBounds, 260];
    const bands = theme.zones
      .map((color, i) => ({ from: Math.max(min, edges[i]!), to: Math.min(max, edges[i + 1]!), color, label: `Z${i + 1}` }))
      .filter((b) => b.to > b.from);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < P.n; i++) if (P.hr[i] === P.hr[i]) (sum += P.hr[i]!), n++;
    out.push({
      key: 'hr',
      label: t('activities.charts.hr'),
      color: theme.series[7]!,
      y: Array.from(h, finite),
      min,
      max,
      bands,
      readout: (fi) => fmt.hr(valueAt(P.hr, fi)),
      axis: (v) => fmt.num(v),
      avg: n ? fmt.hr(sum / n) : '–',
      height: 92,
    });
  }
  if (P.cadence) {
    const c = bucketMean(P.cadence, B);
    const lo = quantile(c, 0.01);
    const hi = quantile(c, 0.995);
    const unit = sport === 'ride' || sport === 'handcycle' ? 'rpm' : 'spm';
    out.push({
      key: 'cadence',
      label: t('activities.charts.cadence'),
      color: theme.series[6]!,
      y: Array.from(c, (v) => (Number.isFinite(v) ? Math.max(lo, v) : null)),
      min: Math.max(0, Math.floor(lo * 0.95)),
      max: Math.ceil(hi * 1.03),
      readout: (fi) => {
        const v = valueAt(P.cadence, fi);
        return v === v ? `${fmt.int(v)} ${unit}` : '–';
      },
      axis: (v) => fmt.num(v),
      avg: `${fmt.int(quantile(c, 0.5))} ${unit}`,
      height: 72,
    });
  }
  if (P.power) {
    const p = bucketMean(P.power, B);
    const hi = quantile(p, 0.995);
    out.push({
      key: 'power',
      label: t('activities.charts.power'),
      color: theme.series[3]!,
      y: Array.from(p, finite),
      min: 0,
      max: Math.ceil((hi * 1.08) / 50) * 50,
      readout: (fi) => fmt.power(valueAt(P.power, fi)),
      axis: (v) => fmt.num(v),
      avg: fmt.power(quantile(p, 0.5)),
      height: 80,
    });
  }
  return out;
}

function chartOption(
  m: Metric,
  xs: number[],
  x0: number,
  x1: number,
  last: boolean,
  xLabel: (v: number) => string,
  theme: ChartTheme,
  gaps: Set<number>,
) {
  // a gap (null) before every bucket where a new part of the track starts: the line is not drawn across the jump
  const data: [number, number | null][] = [];
  xs.forEach((x, i) => {
    if (i > 0 && gaps.has(i)) data.push([x, null]);
    data.push([x, m.y[i] ?? null]);
  });
  return {
    animation: false,
    // fixed plot rect in every chart (ECharts 6 would otherwise shrink grids whose labels touch the canvas edge)
    grid: { left: GL, right: GR, top: 6, bottom: last ? 22 : 5, containLabel: false, outerBoundsMode: 'none' as const },
    xAxis: {
      type: 'value' as const,
      min: x0,
      max: x1,
      axisLine: { show: last, lineStyle: { color: theme.axis } },
      axisTick: { show: false },
      axisLabel: { show: last, color: theme.muted, fontSize: 10, hideOverlap: true, formatter: xLabel },
      splitLine: { show: false },
    },
    yAxis: valueAxis(theme, {
      min: m.min,
      max: m.max,
      inverse: !!m.inverse,
      splitNumber: 2,
      // explicit bounds are rarely round numbers: only label the (nice) interior ticks
      axisLabel: { color: theme.muted, fontSize: 10, formatter: m.axis, showMinLabel: false, showMaxLabel: m.max === undefined },
    }),
    tooltip: { show: false },
    series: [
      {
        type: 'line' as const,
        data,
        showSymbol: false,
        symbol: 'none',
        silent: true,
        connectNulls: false,
        lineStyle: { width: 1.5, color: m.color, join: 'round' as const },
        itemStyle: { color: m.color },
        areaStyle: m.area ? { color: m.color, opacity: 0.14 } : undefined,
        markArea: (m.bands
          ? {
              silent: true,
              label: { show: true, position: 'insideRight', color: theme.muted, fontSize: 9 },
              data: m.bands.map((b) => [
                { yAxis: b.from, name: b.label, itemStyle: { color: b.color, opacity: 0.1 } },
                { yAxis: b.to },
              ]),
            }
          : undefined) as LineSeriesOption['markArea'],
      },
    ],
  };
}

export interface StreamChartsProps {
  P: Prepared;
  sport: string;
  zoneBounds: number[];
  playback: Playback | null;
  hover: Store<number | null>;
  selection: [number, number] | null;
  onSelect: (s: [number, number] | null) => void;
  footer?: ReactNode;
}

/**
 * Stacked stream charts sharing one x axis (distance or time). Hovering moves a crosshair through all charts and the
 * map marker; dragging selects a section; clicking seeks the replay. Overlays are DOM elements updated per frame.
 */
export function StreamCharts({ P, sport, zoneBounds, playback, hover, selection, onSelect, footer }: StreamChartsProps) {
  const { t } = useI18n();
  const fmt = useFormat();
  const theme = useChartTheme();
  const canDist = !!P.dist && P.totalDist > 50;
  const [storedMode, setMode] = useStoredState<XMode>('activities.chartX', 'dist');
  const xMode: XMode = canDist ? storedMode : 'time';
  const unitM = fmt.units === 'imperial' ? M_PER_MI : M_PER_KM;

  const B = useMemo(() => buckets(P.n, 900), [P]);
  const metrics = useMemo(() => buildMetrics(P, B, sport, zoneBounds, theme, fmt, t), [P, B, sport, zoneBounds, theme, fmt, t]);
  /** Full-resolution x values (km/mi or seconds) to map pixels ↔ indices. */
  const xFull = useMemo(() => {
    if (xMode === 'time' || !P.dist) return P.t;
    return P.dist.map((d) => d / unitM);
  }, [P, xMode, unitM]);
  const xs = useMemo(() => Array.from(B.mid, (i) => xFull[i]!), [B, xFull]);
  const x0 = xFull[0]!;
  const x1 = xFull[xFull.length - 1]! || 1;
  const xLabel = useMemo(
    () => (xMode === 'time' ? (v: number) => clock(v) : (v: number) => `${fmt.num(v, x1 < 10 ? 1 : 0)}`),
    [xMode, fmt, x1],
  );
  /** Buckets in which a new part of the GPS track starts (paused and continued elsewhere). */
  const gaps = useMemo(() => {
    const size = B.to[0]! - B.from[0]! + 1;
    return new Set(P.breaks.map((k) => Math.floor(k / size)));
  }, [P.breaks, B]);
  const options = useMemo(
    () => metrics.map((m, i) => chartOption(m, xs, x0, x1, i === metrics.length - 1, xLabel, theme, gaps)),
    [metrics, xs, x0, x1, xLabel, theme, gaps],
  );

  // ---- overlays (imperative) ----
  const wrap = useRef<HTMLDivElement>(null);
  const hoverLine = useRef<HTMLDivElement>(null);
  const playLine = useRef<HTMLDivElement>(null);
  const selRect = useRef<HTMLDivElement>(null);
  const valueRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const drag = useRef<{ startX: number; startI: number; moved: boolean } | null>(null);
  const draft = useRef<[number, number] | null>(null);
  const frame = useRef<number | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const xToPx = (x: number, width: number) => GL + ((x - x0) / (x1 - x0 || 1)) * (width - GL - GR);
  const idxToPx = (fi: number, width: number) => xToPx(valueAt(xFull, fi), width);

  const paint = () => {
    frame.current = null;
    const el = wrap.current;
    if (!el) return;
    const width = el.clientWidth;
    const h = hover.get();
    const started = playback?.state.get().started ?? false;
    const pfi = playback && started ? indexAtTime(P, playback.time.get()) : null;
    if (hoverLine.current) {
      hoverLine.current.style.display = h === null ? 'none' : 'block';
      if (h !== null) hoverLine.current.style.transform = `translateX(${idxToPx(h, width)}px)`;
    }
    if (playLine.current) {
      playLine.current.style.display = pfi === null ? 'none' : 'block';
      if (pfi !== null) playLine.current.style.transform = `translateX(${idxToPx(pfi, width)}px)`;
    }
    const sel = draft.current ?? selectionRef.current;
    if (selRect.current) {
      selRect.current.style.display = sel ? 'block' : 'none';
      if (sel) {
        const a = idxToPx(Math.min(...sel), width);
        const b = idxToPx(Math.max(...sel), width);
        selRect.current.style.transform = `translateX(${a}px)`;
        selRect.current.style.width = `${Math.max(1, b - a)}px`;
      }
    }
    const fi = h ?? pfi;
    metrics.forEach((m, i) => {
      const span = valueRefs.current[i];
      if (!span) return;
      span.textContent = fi === null ? (m.avgIsRange ? m.avg : `${t('activities.charts.avg')} ${m.avg}`) : m.readout(fi);
    });
  };
  const paintRef = useRef(paint);
  paintRef.current = paint;
  const request = () => {
    if (frame.current === null) frame.current = requestAnimationFrame(() => paintRef.current());
  };

  useEffect(() => {
    const unsubs = [hover.subscribe(request)];
    if (playback) unsubs.push(playback.time.subscribe(request), playback.state.subscribe(request));
    const ro = new ResizeObserver(request);
    if (wrap.current) ro.observe(wrap.current);
    request();
    return () => {
      unsubs.forEach((u) => u());
      ro.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover, playback]);
  useEffect(request, [selection, metrics, xMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const indexAt = (clientX: number): number => {
    const el = wrap.current!;
    // in the charts' own CSS pixels, also while the page is zoomed (GL / GR are CSS pixels)
    const { x } = pointerInElement({ clientX, clientY: 0 }, el.getBoundingClientRect(), {
      width: el.offsetWidth,
      height: el.offsetHeight,
    });
    const f = Math.max(0, Math.min(1, (x - GL) / (el.offsetWidth - GL - GR)));
    return fracIndex(xFull, x0 + f * (x1 - x0));
  };

  // ---- table view: one row per km/mi (distance) or 5 minutes (time) ----
  const table = useMemo<TableView>(() => {
    const step = xMode === 'dist' ? 1 : 300;
    const rows: Record<string, ReactNode>[] = [];
    for (let x = x0; x < x1; x += step) {
      const a = Math.round(fracIndex(xFull, x));
      const b = Math.max(a + 1, Math.round(fracIndex(xFull, Math.min(x1, x + step))));
      const mid = (a + b) / 2;
      const row: Record<string, ReactNode> = {
        x: xMode === 'dist' ? `${fmt.num(x, 0)}–${fmt.num(Math.min(x1, x + step), x1 - x < step ? 2 : 0)} ${fmt.distanceUnit}` : `${clock(x)}–${clock(Math.min(x1, x + step))}`,
      };
      for (const m of metrics) row[m.key] = m.readout(mid);
      rows.push(row);
      if (rows.length > 400) break;
    }
    return {
      columns: [
        { key: 'x', label: xMode === 'dist' ? t('activities.charts.xDistance') : t('activities.charts.xTime') },
        ...metrics.map((m) => ({ key: m.key, label: m.label, numeric: true })),
      ],
      rows,
    };
  }, [xMode, x0, x1, xFull, metrics, fmt, t]);

  if (!metrics.length) return null;

  return (
    <ChartCard
      title={t('activities.charts.title')}
      icon={Activity}
      table={table}
      actions={
        canDist ? (
          <SegmentedControl
            size="sm"
            value={xMode}
            onChange={setMode}
            label={t('activities.charts.title')}
            items={[
              { value: 'dist', label: t('activities.charts.xDistance') },
              { value: 'time', label: t('activities.charts.xTime') },
            ]}
          />
        ) : undefined
      }
      footer={footer ?? (playback ? t('activities.charts.hint') : t('activities.charts.hintNoReplay'))}
    >
      <div
        ref={wrap}
        className="relative min-w-0 cursor-crosshair touch-none select-none"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { startX: e.clientX, startI: indexAt(e.clientX), moved: false };
        }}
        onPointerMove={(e) => {
          const i = indexAt(e.clientX);
          hover.set(i);
          const d = drag.current;
          if (d && Math.abs(e.clientX - d.startX) > 4) {
            d.moved = true;
            draft.current = [Math.min(d.startI, i), Math.max(d.startI, i)];
            request();
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (!d) return;
          if (d.moved && draft.current) {
            const [a, b] = draft.current;
            draft.current = null;
            if (b - a >= 2) onSelect([a, b]);
          } else {
            playback?.seek(valueAt(P.t, indexAt(e.clientX)));
          }
          request();
        }}
        onPointerLeave={() => {
          if (!drag.current) hover.set(null);
        }}
        onPointerCancel={() => {
          drag.current = null;
          draft.current = null;
          request();
        }}
      >
        {metrics.map((m, i) => (
          <div key={m.key} className="min-w-0">
            <div className="flex items-baseline justify-between gap-2 pl-[46px] pr-3 text-xs">
              <span className="inline-flex items-center gap-1.5 font-medium text-fg-2">
                <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: m.color }} aria-hidden />
                {m.label}
              </span>
              <span ref={(el) => void (valueRefs.current[i] = el)} className="tabular font-semibold text-fg" />
            </div>
            <EChart option={options[i]!} height={m.height + (i === metrics.length - 1 ? 19 : 0)} ariaLabel={m.label} />
          </div>
        ))}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div ref={selRect} className="absolute inset-y-0 left-0 hidden border-x border-accent bg-accent-soft" />
          <div ref={hoverLine} className="absolute inset-y-0 left-0 hidden w-px bg-fg-3" />
          <div ref={playLine} className="absolute inset-y-0 left-0 -ml-px hidden w-0.5 bg-accent" />
        </div>
      </div>
      {xMode === 'dist' && <div className="mt-0.5 pr-3 text-right text-[10px] text-fg-3">{fmt.distanceUnit}</div>}
    </ChartCard>
  );
}
