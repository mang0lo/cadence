import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { EChartsOption, ECharts } from 'echarts';
import { cn } from '@/components/ui';
import { baseOption } from './options';
import { pointerInElement } from './pointer';

export { pointerInElement };
import { useChartTheme } from './theme';

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

/** Theme-aware ECharts wrapper (canvas). Resizes with its container. */
export function EChart({
  option,
  height = 260,
  className,
  loading,
  notMerge = true,
  onEvents,
  onReady,
  group,
  ariaLabel,
}: EChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  const theme = useChartTheme();
  const handlers = useRef(onEvents);
  handlers.current = onEvents;

  useEffect(() => {
    const node = el.current!;
    const c = echarts.init(node, undefined, { renderer: 'canvas' });
    chart.current = c;
    const stopPointerFix = correctPointerPositions(node, c);
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(node);
    onReady?.(c);
    return () => {
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
    c.setOption({ ...baseOption(theme), ...option }, { notMerge });
  }, [option, theme, notMerge]);

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
