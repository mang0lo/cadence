import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { EChartsOption, ECharts } from 'echarts';
import { cn } from '@/components/ui';
import { baseOption } from './options';
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
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(node);
    onReady?.(c);
    return () => {
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
    return () => bound.forEach(([name, fn]) => c.off(name, fn as never));
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
