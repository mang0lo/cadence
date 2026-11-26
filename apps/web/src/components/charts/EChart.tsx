import { useEffect, useRef } from 'react';
import { BarChart, CustomChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  AxisPointerComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { LegacyGridContainLabel } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption, ECharts } from 'echarts';
import { cn } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { axisNumberFormatter, baseOption, chartLocale, localizeAxes } from './options';
import { pointerInElement } from './pointer';

export { pointerInElement };
import { useChartTheme } from './theme';

// Only what the app's charts use (the full build is more than twice as large). A chart type or option component
// that is not registered here is silently ignored by ECharts: add it when a chart needs one (e.g. DataZoomComponent
// for zooming, MarkPointComponent for markPoint). Label layout is part of echarts/core.
echarts.use([
  LineChart,
  BarChart,
  ScatterChart,
  CustomChart,
  GridComponent,
  TooltipComponent,
  AxisPointerComponent,
  LegendComponent,
  MarkLineComponent,
  MarkAreaComponent,
  VisualMapComponent,
  // the charts' grids use `containLabel` (see options.ts): without this feature ECharts 6 lays them out differently
  LegacyGridContainLabel,
  CanvasRenderer,
]);

export type { EChartsOption, ECharts };

export interface EChartProps {
  option: EChartsOption;
  /** Total height including axis labels (never clip the axis band). */
  height?: number | string;
  className?: string;
  /** While true the previous render stays visible at reduced opacity (no skeleton flash). */
  loading?: boolean;
  /** Replace instead of merge (use when the set of series changes). Default true. */
  notMerge?: boolean;
  /** Event handlers, e.g. { click: (p) => …, updateAxisPointer: (p) => … }. */
  onEvents?: Record<string, (params: any, chart: ECharts) => void>;
  /** Access the instance (e.g. to dispatchAction for synced hovering). */
  onReady?: (chart: ECharts) => void;
  /** Charts sharing a group sync their crosshair (echarts.connect). */
  group?: string;
  ariaLabel?: string;
}

/** Pointer events ECharts (zrender) reads positions from. Touch events are computed correctly by zrender itself. */
const POINTER_EVENTS = [
  'mousemove',
  'mousedown',
  'mouseup',
  'mouseout',
  'click',
  'dblclick',
  'contextmenu',
  'wheel',
  'mousewheel',
  'pointermove',
  'pointerdown',
  'pointerup',
  'pointerout',
] as const;

/**
 * ECharts takes the pointer from `MouseEvent.offsetX/Y`, which some engines report in the unzoomed scale while the
 * page is zoomed (WebKit with pinch or ⌘+ in the Mac app, CSS zoom): the tooltip then showed the value that would be
 * under the pointer without zoom. zrender uses an event's `zrX/zrY` as given when they are already set, so they are
 * set first (capture phase) from the client coordinates, which are right at every zoom level.
 */
function correctPointerPositions(container: HTMLElement, chart: ECharts): () => void {
  const root = (): HTMLElement =>
    (chart.getZr() as unknown as { painter?: { getViewportRoot?: () => HTMLElement } }).painter?.getViewportRoot?.() ??
    container;
  const onEvent = (e: Event) => {
    const me = e as MouseEvent & { zrX?: number; zrY?: number };
    if (typeof me.clientX !== 'number') return;
    const el = root();
    const p = pointerInElement(me, el.getBoundingClientRect(), { width: el.offsetWidth, height: el.offsetHeight });
    me.zrX = p.x;
    me.zrY = p.y;
  };
  for (const type of POINTER_EVENTS) container.addEventListener(type, onEvent, { capture: true, passive: true });
  return () => {
    for (const type of POINTER_EVENTS) container.removeEventListener(type, onEvent, { capture: true });
  };
}

/**
 * Theme-aware ECharts wrapper (canvas). Resizes with its container. Numeric axes without a label formatter of their
 * own show the user's number format, time axes the month names of the user's language.
 */
export function EChart(props: EChartProps) {
  const { locale } = useI18n();
  // ECharts takes its locale (month names on time axes) when a chart is created: another language makes a new chart
  return <ChartCanvas key={locale} locale={locale} {...props} />;
}

function ChartCanvas({
  option,
  height = 260,
  className,
  loading,
  notMerge = true,
  onEvents,
  onReady,
  group,
  ariaLabel,
  locale,
}: EChartProps & { locale: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const theme = useChartTheme();
  const handlers = useRef(onEvents);
  handlers.current = onEvents;

  useEffect(() => {
    const node = el.current!;
    // only the time names: ECharts fills in the rest from its English locale
    const c = echarts.init(node, undefined, { renderer: 'canvas', locale: chartLocale(locale) as never });
    chart.current = c;
    const stopPointerFix = correctPointerPositions(node, c);
    // at most one resize per frame, outside the observer's callback (a resize lays out the whole chart at once; a page
    // with many charts would do that for each of them on every callback while the window is dragged)
    let frame = 0;
    const ro = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!c.isDisposed()) c.resize();
      });
    });
    ro.observe(node);
    onReady?.(c);
    return () => {
      cancelAnimationFrame(frame);
      stopPointerFix();
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    c.setOption({ ...baseOption(theme), ...localizeAxes(option, axisNumberFormatter(locale)) }, { notMerge });
  }, [option, theme, notMerge, locale]);

  useEffect(() => {
    const c = chart.current;
    if (!c || !onEvents) return;
    const names = Object.keys(onEvents);
    const bound = names.map((name) => {
      const fn = (p: unknown) => handlers.current?.[name]?.(p, c);
      c.on(name, fn as never);
      return [name, fn] as const;
    });
    return () => {
      if (!c.isDisposed()) bound.forEach(([name, fn]) => c.off(name, fn as never));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onEvents ? Object.keys(onEvents).join(',') : '']);

  useEffect(() => {
    const c = chart.current;
    if (!c || !group) return;
    c.group = group;
    echarts.connect(group);
  }, [group]);

  return (
    <div
      ref={el}
      role="img"
      aria-label={ariaLabel}
      className={cn('w-full transition-opacity', loading && 'opacity-50', className)}
      style={{ height }}
    />
  );
}
