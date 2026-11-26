import { useMemo, type ReactNode } from 'react';
import type { SeriesOption } from 'echarts';
import type { LucideIcon } from 'lucide-react';
import { mean, rollingMeanByDay, shiftDay, type GoodDirection, type MetricAgg } from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { axisTooltip, grid, legend, lineSeries, timeAxis, tooltipHtml, valueAxis } from '@/components/charts/options';
import { useChartTheme } from '@/components/charts/theme';
import { Skeleton } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { LEGEND_LINE_ICON, dayAxisLabel } from '../lib/chart';
import { useMetricFormat } from '../lib/metrics';
import { useDayLabel } from './MetricCard';
import { TrendDelta } from './TrendDelta';

export interface TrendPoint {
  day: string;
  value: number;
  min?: number | null;
  max?: number | null;
}

export interface TrendChartProps {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  /** Catalogue identifier used for conversion / formatting. */
  metric: string;
  /** Canonical unit of the record type (for metrics the catalogue cannot format by itself). */
  unit?: string | null;
  /** All points; those before `fromDay` only warm up the rolling mean. */
  points: TrendPoint[];
  /** First visible day (default: all points are visible). */
  fromDay?: string;
  /** Series color (palette slot of the measure). */
  color: string;
  /** Draw a trailing mean over this many days as the main line (daily values become the faint line). */
  rolling?: number;
  /** Draw the min–max band of each day (points need min/max). */
  band?: boolean;
  /** What a point stands for (labels of tooltips / table); default: one day. */
  agg?: MetricAgg;
  height?: number;
  loading?: boolean;
  /** Shown instead of the chart when there are no points. */
  emptyText: string;
  /** Preferred direction for the "vs. start of range" delta; null = neutral. */
  good?: GoodDirection;
  /** Extra content in the footer (e.g. a hint). */
  footerExtra?: ReactNode;
}

/** Window (days) at both ends of the range that are compared for the trend. */
const EDGE_DAYS = 30;

/**
 * Daily values of one health measure over time: thin daily line, optional rolling mean as the main line, optional
 * min–max band; legend only when there are ≥ 2 series, tooltip with every value, table view, footer with latest /
 * average / range and the change versus the start of the range.
 */
export function TrendChart({
  title,
  subtitle,
  icon,
  metric,
  unit,
  points: allPoints,
  fromDay,
  color,
  rolling = 0,
  band = false,
  agg = 'day',
  height = 250,
  loading,
  emptyText,
  good = null,
  footerExtra,
}: TrendChartProps) {
  const t = useT();
  const fmt = useFormat();
  const m = useMetricFormat();
  const theme = useChartTheme();
  const dayLabel = useDayLabel();
  const unitLabel = m.unitLabel(metric, unit);
  const keyLabel = (key: string, long: boolean) =>
    agg === 'month'
      ? fmt.day(key, 'month')
      : agg === 'week'
        ? t('health.common.weekOf', { date: fmt.day(key, 'dayShort') })
        : fmt.day(key, long ? 'weekday' : 'weekdayShort');
  const start = useMemo(() => {
    if (!fromDay) return 0;
    const i = allPoints.findIndex((p) => p.day >= fromDay);
    return i < 0 ? allPoints.length : i;
  }, [allPoints, fromDay]);
  const points = useMemo(() => allPoints.slice(start), [allPoints, start]);

  const model = useMemo(() => {
    const conv = (v: number) => m.toDisplay(metric, v, unit);
    const hasBand = band && points.some((p) => p.min != null && p.max != null);
    const roll = rolling > 0 ? rollingMeanByDay(allPoints, rolling).slice(start) : null;
    const shown = points.map((p) => conv(p.value));
    const lows = points.map((p) => (p.min == null ? null : conv(p.min)));
    const highs = points.map((p) => (p.max == null ? null : conv(p.max)));
    const rollShown = roll ? roll.map((v) => (v === null ? null : conv(v))) : null;
    const all = [...shown, ...(hasBand ? [...lows, ...highs] : [])].filter((v): v is number => v !== null);
    const span = all.length ? Math.max(...all) - Math.min(...all) : 0;
    const axisDigits = span < 2 ? 2 : span < 10 ? 1 : 0;
    return { conv, hasBand, shown, lows, highs, rollShown, axisDigits };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, allPoints, start, band, rolling, metric, unit, m.units]);

  const names = {
    daily: t('health.common.daily'),
    avg: rolling > 0 ? t('health.common.rollingAvg', { days: rolling }) : t('health.common.average'),
    range: t('health.common.dayRange'),
  };

  const option = useMemo(() => {
    const { hasBand, shown, lows, highs, rollShown } = model;
    const withBandAvg = hasBand; // band charts show the daily mean as the line
    const dailyName = withBandAvg ? names.avg : names.daily;
    const faint = rollShown !== null;
    const series: SeriesOption[] = [];
    if (hasBand) {
      // stacked: transparent base (min) + visible range (max − min); excluded from the line legend via legend.data
      series.push({
        type: 'line',
        name: '__base',
        data: points.map((p, i) => [p.day, lows[i]]),
        stack: 'band',
        symbol: 'none',
        lineStyle: { opacity: 0 },
        silent: true,
        tooltip: { show: false },
        emphasis: { disabled: true },
      });
      series.push({
        type: 'line',
        name: names.range,
        data: points.map((p, i) => [p.day, lows[i] === null || highs[i] === null ? null : highs[i]! - lows[i]!]),
        stack: 'band',
        symbol: 'none',
        lineStyle: { opacity: 0 },
        areaStyle: { color, opacity: 0.14 },
        silent: true,
        emphasis: { disabled: true },
        tooltip: { show: false },
      });
    }
    series.push(
      lineSeries(
        theme,
        faint ? names.daily : dailyName,
        points.map((p, i) => [p.day, shown[i]]),
        color,
        {
          showSymbol: points.length <= 90,
          symbolSize: faint ? 5 : 6,
          lineStyle: { width: faint ? 1.25 : 2, color, opacity: faint ? 0.45 : 1, cap: 'round', join: 'round' },
          itemStyle: { color, opacity: faint ? 0.55 : 1, borderColor: theme.surface, borderWidth: faint ? 1 : 2 },
        },
      ),
    );
    if (rollShown) {
      series.push(lineSeries(theme, names.avg, points.map((p, i) => [p.day, rollShown[i]]), color, { symbolSize: 6 }));
    }
    const legendData: object[] = [];
    if (hasBand) legendData.push({ name: names.range, icon: 'roundRect', itemStyle: { color, opacity: 0.3, borderWidth: 0 } });
    if (faint) legendData.push({ name: names.daily, itemStyle: { color, opacity: 0.5, borderWidth: 0 } });
    legendData.push({ name: faint ? names.avg : dailyName, itemStyle: { color, borderWidth: 0 } });
    const multi = legendData.length >= 2;
    return {
      grid: grid({ top: multi ? 34 : 12 }),
      legend: multi ? legend(theme, 'line', { data: legendData, ...LEGEND_LINE_ICON }) : { show: false },
      tooltip: axisTooltip(theme, (params) => {
        const p = (params as { dataIndex: number }[]).find((x) => x.dataIndex !== undefined);
        const i = p?.dataIndex ?? -1;
        const pt = points[i];
        if (!pt) return '';
        const rows = [{ color, label: faint ? names.daily : dailyName, value: m.value(metric, pt.value, unit) }];
        if (rollShown && rollShown[i] !== null && rollShown[i] !== undefined) {
          rows.push({ color, label: names.avg, value: fmt.num(rollShown[i]!, model.axisDigits === 0 ? 1 : model.axisDigits) + (unitLabel ? ` ${unitLabel}` : '') });
        }
        if (hasBand && pt.min != null && pt.max != null) {
          rows.push({ color, label: names.range, value: `${m.plain(metric, pt.min, unit)} – ${m.value(metric, pt.max, unit)}` });
        }
        return tooltipHtml(keyLabel(pt.day, true), rows, theme);
      }),
      xAxis: timeAxis(theme, { axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: dayAxisLabel(fmt) } }),
      yAxis: valueAxis(theme, {
        scale: true,
        axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => fmt.num(v, model.axisDigits) },
      }),
      series,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, points, theme, fmt, color, names.avg, names.daily, names.range]);

  const summary = useMemo(() => {
    if (!points.length) return null;
    const vals = points.map((p) => p.value);
    const last = points[points.length - 1]!;
    const lo = Math.min(...points.map((p) => p.min ?? p.value));
    const hi = Math.max(...points.map((p) => p.max ?? p.value));
    // change between the first and the last EDGE_DAYS of the range
    let delta: { value: number; text: string } | null = null;
    const first = points[0]!;
    if (points.length >= 6 && first.day <= shiftDay(last.day, -2 * EDGE_DAYS + 1)) {
      const head = points.filter((p) => p.day < shiftDay(first.day, EDGE_DAYS)).map((p) => p.value);
      const tail = points.filter((p) => p.day > shiftDay(last.day, -EDGE_DAYS)).map((p) => p.value);
      if (head.length >= 3 && tail.length >= 3) delta = m.delta(metric, mean(tail)! - mean(head)!, unit);
    }
    return { last, avg: mean(vals)!, lo, hi, delta };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, metric, unit, m.units]);

  const table = useMemo(
    () => ({
      columns: [
        { key: 'day', label: t('health.common.date') },
        { key: 'value', label: names.daily + (unitLabel ? ` (${unitLabel})` : ''), numeric: true },
        ...(band ? [{ key: 'min', label: t('health.common.min'), numeric: true }, { key: 'max', label: t('health.common.max'), numeric: true }] : []),
        ...(rolling > 0 ? [{ key: 'roll', label: names.avg, numeric: true }] : []),
      ],
      rows: [...points].reverse().map((p) => {
        const i = points.indexOf(p);
        return {
          day: keyLabel(p.day, false),
          value: m.plain(metric, p.value, unit),
          min: p.min == null ? '–' : m.plain(metric, p.min, unit),
          max: p.max == null ? '–' : m.plain(metric, p.max, unit),
          roll: model.rollShown?.[i] == null ? '–' : fmt.num(model.rollShown[i]!, model.axisDigits === 0 ? 1 : model.axisDigits),
        };
      }),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [points, band, rolling, model, fmt, unitLabel],
  );

  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      icon={icon}
      table={points.length ? table : undefined}
      footer={
        summary ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              {t('health.common.latest')} <b className="font-semibold text-fg">{m.value(metric, summary.last.value, unit)}</b>{' '}
              {/* a week or month point is the mean of that period, not the value of its first day */}
              <span className="text-fg-3">{agg === 'day' ? dayLabel(summary.last.day) : keyLabel(summary.last.day, false)}</span>
            </span>
            <span>
              {t('health.common.avg')} <b className="font-semibold text-fg">{m.value(metric, summary.avg, unit)}</b>
            </span>
            <span>
              {t('health.common.range')}{' '}
              <b className="font-semibold text-fg">
                {m.plain(metric, summary.lo, unit)}–{m.value(metric, summary.hi, unit)}
              </b>
            </span>
            {summary.delta && (
              <span className="inline-flex items-center gap-1">
                <TrendDelta value={summary.delta.value} text={summary.delta.text} good={good} />
                <span className="text-fg-3">{t('health.common.vsStart')}</span>
              </span>
            )}
            {footerExtra}
          </div>
        ) : undefined
      }
    >
      {loading && !points.length ? (
        <div style={{ height }}>
          <Skeleton className="h-full w-full" />
        </div>
      ) : points.length === 0 ? (
        <p className="py-10 text-center text-sm text-fg-3" style={{ minHeight: height - 60 }}>
          {emptyText}
        </p>
      ) : (
        <EChart option={option} height={height} ariaLabel={title} />
      )}
    </ChartCard>
  );
}
