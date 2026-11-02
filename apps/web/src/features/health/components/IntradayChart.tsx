import { useMemo, type ReactNode } from 'react';
import type { MarkAreaComponentOption, SeriesOption } from 'echarts';
import type { LucideIcon } from 'lucide-react';
import { workoutTitle, type IntradayBucket, type IntradayResponse, type Page, type WorkoutSummary } from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { sportColor, useChartTheme } from '@/components/charts/theme';
import {
  axisTooltip,
  barSeries,
  categoryAxis,
  grid,
  legend,
  lineSeries,
  timeAxis,
  tooltipHtml,
  valueAxis,
} from '@/components/charts/options';
import { Link } from 'react-router';
import { ErrorState, Skeleton } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useI18n, useT } from '@/lib/i18n';
import { SportIcon, sportColorVar } from '@/lib/sports';
import { LEGEND_LINE_ICON } from '../lib/chart';
import { useMetricFormat } from '../lib/metrics';

export interface IntradayChartProps {
  /** Record type identifier (quantity types only). */
  type: string;
  /** Canonical unit of the record type. */
  unit?: string | null;
  day: string;
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  color: string;
  /** Bucket size in minutes (server default: 5 for averages, 60 for cumulative types). */
  bucket?: number;
  /** Horizontal reference line in canonical units (e.g. the resting heart rate of that day). */
  reference?: { value: number; label: string } | null;
  /** Shade the time of that day's workouts. */
  workouts?: boolean;
  height?: number;
  actions?: ReactNode;
}

function withGaps(buckets: IntradayBucket[], bucketS: number, f: (b: IntradayBucket) => [number, number | null]): ([number, number | null])[] {
  const out: ([number, number | null])[] = [];
  buckets.forEach((b, i) => {
    const prev = buckets[i - 1];
    // a gap of more than three buckets breaks the line instead of drawing a misleading straight segment
    if (prev && b.ts - prev.ts > bucketS * 3) out.push([(prev.ts + bucketS) * 1000, null]);
    out.push(f(b));
  });
  return out;
}

/** One day of a quantity type in small buckets: min–max band + mean for rates, bars for cumulative types. */
export function IntradayChart({
  type,
  unit,
  day,
  title,
  subtitle,
  icon,
  color,
  bucket,
  reference,
  workouts = false,
  height = 260,
  actions,
}: IntradayChartProps) {
  const t = useT();
  const fmt = useFormat();
  const m = useMetricFormat();
  const { lang } = useI18n();
  const theme = useChartTheme();
  const q = useApi<IntradayResponse>(['health', 'intraday', type], '/health/intraday', { type, day, bucket });
  // while another day loads the previous one stays visible (dimmed) instead of flashing a skeleton
  const d = q.data ?? null;
  const stale = !!d && (d.day !== day || d.type !== type);
  const w = useApi<Page<WorkoutSummary>>(
    ['health', 'intraday-workouts'],
    d && workouts ? '/workouts' : null,
    d ? { from: d.dayStartTs, to: d.dayEndTs, limit: 20, sort: 'start', order: 'asc' } : undefined,
  );
  const wk = workouts && d && w.data ? w.data.items.filter((x) => x.startTs >= d.dayStartTs && x.startTs < d.dayEndTs) : [];

  const cumulative = d?.aggregation === 'sum';
  const unitLabel = m.unitLabel(type, unit);

  const built = useMemo(() => {
    if (!d) return null;
    const off = d.tzMin * 60;
    const x = (ts: number) => (ts + off) * 1000;
    const conv = (v: number) => m.toDisplay(type, v, unit);
    const xs = timeAxis(theme, {
      min: x(d.dayStartTs),
      max: x(d.dayEndTs),
      axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: (v: number) => fmt.time(v / 1000, 0) },
    });
    const areas: MarkAreaComponentOption | undefined =
      wk.length === 0
        ? undefined
        : {
            silent: true,
            label: { show: true, position: 'insideTop', color: theme.fg2, fontSize: 11 },
            data: wk.map((x0) => [
              { xAxis: x(x0.startTs), name: workoutTitle(x0, lang), itemStyle: { color: sportColor(theme, x0.sport), opacity: 0.14 } },
              { xAxis: x(Math.min(x0.endTs, d.dayEndTs)) },
            ]) as unknown as MarkAreaComponentOption['data'],
          };

    if (cumulative) {
      const n = Math.max(1, Math.ceil((d.dayEndTs - d.dayStartTs) / d.bucketS));
      const byIdx = new Map(d.buckets.map((b) => [Math.round((b.ts - d.dayStartTs) / d.bucketS), b]));
      const labels = Array.from({ length: n }, (_, i) => fmt.time(d.dayStartTs + i * d.bucketS, d.tzMin));
      const vals = Array.from({ length: n }, (_, i) => {
        const b = byIdx.get(i);
        return b ? conv(b.avg) : 0;
      });
      const s = barSeries(theme, title, vals, color, { barMaxWidth: 18 });
      return {
        option: {
          grid: grid({ top: 12 }),
          tooltip: axisTooltip(
            theme,
            (params) => {
              const p = (params as { dataIndex: number }[])[0];
              const i = p?.dataIndex ?? -1;
              const b = byIdx.get(i);
              if (!b) return '';
              const end = d.dayStartTs + (i + 1) * d.bucketS;
              return tooltipHtml(
                `${fmt.time(b.ts, d.tzMin)} – ${fmt.time(end, d.tzMin)}`,
                [{ color, label: title, value: m.value(type, b.avg, unit) }],
                theme,
              );
            },
            { axisPointer: { type: 'shadow', shadowStyle: { color: theme.grid, opacity: 0.35 } } },
          ),
          xAxis: categoryAxis(theme, labels, { axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true } }),
          yAxis: valueAxis(theme, { axisLabel: { color: theme.muted, fontSize: 11 } }),
          series: [s],
        },
        rows: d.buckets.map((b) => ({
          time: fmt.time(b.ts, d.tzMin),
          avg: m.plain(type, b.avg, unit),
          min: '',
          max: '',
        })),
        columns: [
          { key: 'time', label: t('health.common.time') },
          { key: 'avg', label: unitLabel || t('health.common.value'), numeric: true },
        ],
      };
    }

    const bands = withGaps(d.buckets, d.bucketS, (b) => [x(b.ts + d.bucketS / 2), conv(b.avg)]);
    const lows = withGaps(d.buckets, d.bucketS, (b) => [x(b.ts + d.bucketS / 2), conv(b.min)]);
    const spans = withGaps(d.buckets, d.bucketS, (b) => [x(b.ts + d.bucketS / 2), conv(b.max) - conv(b.min)]);
    const avgName = t('health.common.average');
    const rangeName = t('health.common.minMax');
    const series: SeriesOption[] = [
      {
        type: 'line',
        name: '__base',
        data: lows,
        stack: 'band',
        symbol: 'none',
        lineStyle: { opacity: 0 },
        silent: true,
        tooltip: { show: false },
        emphasis: { disabled: true },
      },
      {
        type: 'line',
        name: rangeName,
        data: spans,
        stack: 'band',
        symbol: 'none',
        lineStyle: { opacity: 0 },
        areaStyle: { color, opacity: 0.16 },
        silent: true,
        tooltip: { show: false },
        emphasis: { disabled: true },
      },
      lineSeries(theme, avgName, bands, color, {
        markLine: reference
          ? {
              silent: true,
              symbol: 'none',
              animation: false,
              lineStyle: { color: theme.fg2, width: 1, type: 'solid', opacity: 0.6 },
              label: { show: true, position: 'insideStartTop', color: theme.fg2, fontSize: 11, formatter: reference.label },
              data: [{ yAxis: conv(reference.value) }],
            }
          : undefined,
        markArea: areas,
      }),
    ];
    return {
      option: {
        useUTC: true,
        grid: grid({ top: 34, right: 26 }),
        legend: legend(theme, 'line', {
          data: [
            { name: rangeName, icon: 'roundRect', itemStyle: { color, opacity: 0.35, borderWidth: 0 } },
            { name: avgName, itemStyle: { color, borderWidth: 0 } },
          ],
          ...LEGEND_LINE_ICON,
        }),
        tooltip: axisTooltip(theme, (params) => {
          const p = (params as { dataIndex: number; seriesName: string }[]).find((x) => x.seriesName === avgName);
          // the line series has gap entries; map back through the bucket timestamp
          const idx = p?.dataIndex ?? -1;
          const pt = bands[idx];
          if (!pt || pt[1] === null) return '';
          const ts = pt[0] / 1000 - d.tzMin * 60 - d.bucketS / 2;
          const b = d.buckets.find((bb) => bb.ts === ts);
          if (!b) return '';
          return tooltipHtml(
            `${fmt.time(b.ts, d.tzMin)} – ${fmt.time(b.ts + d.bucketS, d.tzMin)}`,
            [
              { color, label: avgName, value: m.value(type, b.avg, unit) },
              { color, label: rangeName, value: `${m.plain(type, b.min, unit)} – ${m.value(type, b.max, unit)}` },
            ],
            theme,
          );
        }),
        xAxis: xs,
        yAxis: valueAxis(theme, { scale: true, axisLabel: { color: theme.muted, fontSize: 11 } }),
        series,
      },
      rows: d.buckets.map((b) => ({
        time: fmt.time(b.ts, d.tzMin),
        avg: m.plain(type, b.avg, unit),
        min: m.plain(type, b.min, unit),
        max: m.plain(type, b.max, unit),
      })),
      columns: [
        { key: 'time', label: t('health.common.time') },
        { key: 'avg', label: `${avgName}${unitLabel ? ` (${unitLabel})` : ''}`, numeric: true },
        { key: 'min', label: t('health.common.min'), numeric: true },
        { key: 'max', label: t('health.common.max'), numeric: true },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, wk.length, theme, fmt, m, color, reference?.value, reference?.label, lang]);

  const stats = useMemo(() => {
    if (!d || !d.buckets.length) return null;
    if (cumulative) return { total: d.buckets.reduce((s, b) => s + b.avg, 0) };
    const lo = Math.min(...d.buckets.map((b) => b.min));
    const hi = Math.max(...d.buckets.map((b) => b.max));
    const sum = d.buckets.reduce((s, b) => s + b.avg * b.n, 0);
    const n = d.buckets.reduce((s, b) => s + b.n, 0);
    return { lo, hi, avg: sum / n };
  }, [d, cumulative]);

  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      icon={icon}
      actions={actions}
      table={built && d && d.buckets.length ? { columns: built.columns, rows: built.rows } : undefined}
      footer={
        d && stats ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {'total' in stats ? (
                <span>
                  {t('health.common.total')} <b className="font-semibold text-fg">{m.value(type, stats.total, unit)}</b>
                </span>
              ) : (
                <>
                  <span>
                    {t('health.common.min')} <b className="font-semibold text-fg">{m.value(type, stats.lo, unit)}</b>
                  </span>
                  <span>
                    {t('health.common.avg')} <b className="font-semibold text-fg">{m.value(type, stats.avg, unit)}</b>
                  </span>
                  <span>
                    {t('health.common.max')} <b className="font-semibold text-fg">{m.value(type, stats.hi, unit)}</b>
                  </span>
                </>
              )}
              <span className="text-fg-3">{t('health.common.samplesCount', { count: d.sampleCount })}</span>
            </div>
            {wk.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {wk.map((x) => (
                  <Link key={x.id} to={`/activities/${x.id}`} className="inline-flex items-center gap-1.5 text-fg-2 hover:text-fg hover:underline">
                    <span className="grid size-4 place-items-center rounded-full text-white" style={{ background: sportColorVar(x.sport) }}>
                      <SportIcon sport={x.sport} size={10} strokeWidth={2.5} />
                    </span>
                    {workoutTitle(x, lang)}
                    <span className="text-fg-3 tabular">{fmt.time(x.startTs, d.tzMin)}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        ) : undefined
      }
    >
      {q.error ? (
        <ErrorState error={q.error} />
      ) : !d ? (
        <div style={{ height }}>
          <Skeleton className="h-full w-full" />
        </div>
      ) : d.buckets.length === 0 ? (
        <p className="flex items-center justify-center text-sm text-fg-3" style={{ height: height - 40 }}>
          {t('health.common.noDataDay')}
        </p>
      ) : (
        <EChart option={built!.option} height={height} ariaLabel={title} loading={stale || q.isFetching} />
      )}
    </ChartCard>
  );
}
