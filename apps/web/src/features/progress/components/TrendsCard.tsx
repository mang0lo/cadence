import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Activity as ActivityIcon, TrendingUp } from 'lucide-react';
import type { EChartsOption } from 'echarts';
import {
  sportInfo,
  workoutTitle,
  type ProgressTrendMetric,
  type ProgressTrendSeries,
  type ProgressTrendWorkout,
  type ProgressTrendsResponse,
} from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { grid, itemTooltip, lineSeries, scatterSeries, timeAxis, tooltipHtml, valueAxis } from '@/components/charts/options';
import { sportColor, useChartTheme, type ChartTheme } from '@/components/charts/theme';
import { Button, EmptyState, ErrorState, cn } from '@/components/ui';
import { useFormat, type Formatter } from '@/lib/format';
import { useI18n, useT, type Lang, type TFunction } from '@/lib/i18n';
import { sportLabel } from '@/lib/sports';
import { useTrends, type RangeParams } from '../api';
import { chartLegend, clockAxis, hitLayer, localMs, monthYearLabel, msDay, timeAxisLabel } from '../chart';
import { formatChange, speedLabel, trendFormat, type TrendFormat } from '../format';
import { ActivityLink, ChangeBadge, ChartSkeleton } from './common';

const HEIGHT = 300;

export function trendMetricLabel(t: TFunction, metric: ProgressTrendMetric, sport: string): string {
  if (metric === 'speed') return speedLabel(t, sport);
  if (metric === 'cadence')
    return t(sportInfo(sport).group === 'cycle' ? 'progress.trends.metrics.cadenceCycle' : 'progress.trends.metrics.cadenceFoot');
  return t(`progress.trends.metrics.${metric}`);
}

/** Verdict text + badge props for a series' change. */
export function changeVerdict(s: ProgressTrendSeries, fmt: Formatter, t: TFunction, tf: TrendFormat) {
  if (s.change === null) return null;
  const small = s.changeKind === 'absolute' ? Math.abs(s.change) < 0.5 : Math.abs(s.change) < 0.01;
  if (small || (s.better !== null && s.improved === null)) return { value: 0, better: null, label: t('progress.trends.stable') };
  if (s.better === null)
    return { value: s.change, better: null, label: t('progress.trends.changed', { value: formatChange(fmt, s.change, s.changeKind, tf) }) };
  return {
    value: s.change,
    better: s.better,
    label: t(s.improved ? 'progress.trends.improved' : 'progress.trends.declined', {
      value: formatChange(fmt, s.change, s.changeKind, tf, true),
    }),
  };
}

function buildOption(
  data: ProgressTrendsResponse,
  s: ProgressTrendSeries,
  o: { theme: ChartTheme; fmt: Formatter; t: TFunction; tf: TrendFormat; lang: Lang; names: { points: string; median: string; trend: string } },
): EChartsOption {
  const { theme, fmt, t, tf, lang, names } = o;
  const w = (i: number) => data.workouts[i]!;
  const xs = s.points.map(([i]) => localMs(w(i).startTs, w(i).tzMin));
  const pts = s.points.map(([i, v], k) => ({ value: [xs[k]!, tf.toChart(v)], workout: i, raw: v }));
  const median = s.median.map((v, k) => [xs[k]!, tf.toChart(v)]);
  const color = sportColor(theme, data.sport);
  let trend: number[][] = [];
  if (s.fit) {
    const f = s.fit;
    const tz = w(s.points[0]![0]).tzMin;
    trend = Array.from({ length: 25 }, (_, k) => {
      const ts = f.startTs + ((f.endTs - f.startTs) * k) / 24;
      return [localMs(ts, tz), tf.toChart(f.startValue + (f.slopePerDay * (ts - f.startTs)) / 86400)];
    });
  }
  const span = xs.length ? (xs[xs.length - 1]! - xs[0]!) / 86_400_000 : 0;
  const tooltip = (p: unknown) => {
    const d = (p as { data?: { workout: number; raw: number } }).data;
    if (!d) return '';
    const wk: ProgressTrendWorkout = w(d.workout);
    const rows = [{ color, label: trendMetricLabel(t, s.metric, data.sport), value: tf.format(d.raw) }];
    if (wk.distanceM) rows.push({ color: 'transparent', label: t('common.distance'), value: fmt.distance(wk.distanceM) });
    rows.push({ color: 'transparent', label: t('common.movingTime'), value: fmt.durationShort(wk.movingS) });
    return tooltipHtml(`${workoutTitle(wk, lang)} · ${fmt.date(wk.startTs, wk.tzMin, 'day')}`, rows, theme);
  };
  return {
    useUTC: true,
    grid: grid({ top: 40 }),
    legend: chartLegend(theme, 'line', {
      data: [
        { name: names.points, icon: 'circle', itemStyle: { color, opacity: 0.7, borderWidth: 0 } },
        { name: names.median },
        ...(trend.length ? [{ name: names.trend }] : []),
      ],
    }),
    xAxis: timeAxis(theme, { axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: timeAxisLabel(fmt, span) } }),
    yAxis: valueAxis(theme, {
      scale: true,
      inverse: tf.inverse,
      // pace: round clock steps (0:30, 1:00 …)
      ...(tf.inverse ? clockAxis([...pts.map((p) => p.value[1]!), ...trend.map((p) => p[1]!)], 5, 60) : {}),
      axisLabel: { color: theme.muted, fontSize: 11, formatter: (n: number) => tf.axisLabel(n) },
    }),
    tooltip: itemTooltip(theme, tooltip),
    series: [
      scatterSeries(theme, names.points, pts, color, {
        symbolSize: 7,
        itemStyle: { color, opacity: 0.55, borderColor: theme.surface, borderWidth: 1 },
        emphasis: { scale: 1.5, itemStyle: { opacity: 1 } },
      }),
      lineSeries(theme, names.median, median, theme.fg2, { silent: true, z: 4 }),
      ...(trend.length
        ? [
            lineSeries(theme, names.trend, trend, theme.fg, {
              silent: true,
              z: 5,
              lineStyle: { width: 2, color: theme.fg, type: [6, 4], cap: 'round' },
            }),
          ]
        : []),
      hitLayer('hit', pts),
    ],
  } as EChartsOption;
}

export function TrendsCard({
  sport,
  range,
  sportsWithData,
  onPickSport,
}: {
  sport: string;
  range: RangeParams | null;
  /** Sports offered when "all sports" is selected. */
  sportsWithData: string[];
  onPickSport: (s: string) => void;
}) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const { lang } = useI18n();
  const navigate = useNavigate();
  const q = useTrends(sport, range);
  const data = sport === 'all' ? undefined : q.data;
  const [picked, setPicked] = useState<ProgressTrendMetric | null>(null);
  const series = data?.series ?? [];
  const selected = series.find((s) => s.metric === picked) ?? series.find((s) => s.metric === 'speed') ?? series[0] ?? null;
  const dataSport = data?.sport ?? sport;
  const selectedMetric = selected?.metric ?? null;
  // stable across renders, so the chart option is only rebuilt when something really changed
  const tf = useMemo(() => (selectedMetric ? trendFormat(fmt, t, selectedMetric, dataSport) : null), [fmt, t, selectedMetric, dataSport]);
  const names = useMemo(
    () => ({ points: t('progress.trends.legend.points'), median: t('progress.trends.legend.median'), trend: t('progress.trends.legend.trend') }),
    [t],
  );
  const option = useMemo(
    () => (data && selected && tf && selected.points.length ? buildOption(data, selected, { theme, fmt, t, tf, lang, names }) : null),
    [data, selected, tf, theme, fmt, t, lang, names],
  );
  const onEvents = useMemo(
    () => ({
      click: (p: { data?: { workout?: number } }) => {
        const i = p.data?.workout;
        if (i !== undefined && data) navigate(`/activities/${data.workouts[i]!.id}`);
      },
    }),
    [data, navigate],
  );

  const table = useMemo(() => {
    if (!data || !selected || !tf) return undefined;
    return {
      columns: [
        { key: 'date', label: t('progress.common.date') },
        { key: 'activity', label: t('progress.common.activity') },
        { key: 'value', label: trendMetricLabel(t, selected.metric, dataSport), numeric: true },
        { key: 'median', label: t('progress.trends.median'), numeric: true },
      ],
      rows: selected.points
        .map(([i, v], k) => {
          const w = data.workouts[i]!;
          return {
            date: fmt.date(w.startTs, w.tzMin, 'day'),
            activity: <ActivityLink w={w} />,
            value: tf.format(v),
            median: tf.format(selected.median[k]!),
          };
        })
        .reverse(),
    };
  }, [data, selected, tf, fmt, t, dataSport]);

  if (sport === 'all') {
    return (
      <ChartCard title={t('progress.trends.title')} icon={TrendingUp}>
        <EmptyState
          icon={ActivityIcon}
          title={t('progress.trends.pickSport')}
          description={t('progress.trends.pickSportHint')}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {sportsWithData.slice(0, 4).map((s) => (
                <Button key={s} size="sm" onClick={() => onPickSport(s)}>
                  {sportLabel(s, lang)}
                </Button>
              ))}
            </div>
          }
        />
      </ChartCard>
    );
  }

  const verdict = selected && tf ? changeVerdict(selected, fmt, t, tf) : null;
  return (
    <ChartCard
      title={t('progress.trends.title')}
      subtitle={selected ? t('progress.trends.subtitle', { n: selected.medianWindow }) : undefined}
      icon={TrendingUp}
      table={table}
    >
      {q.error ? (
        <ErrorState error={q.error} />
      ) : !data ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
            {Array.from({ length: 5 }, (_, i) => (
              <ChartSkeleton key={i} height={68} />
            ))}
          </div>
          <ChartSkeleton height={HEIGHT} />
        </>
      ) : !series.length ? (
        <EmptyState title={t('progress.trends.noData')} description={t('progress.trends.noDataHint')} />
      ) : (
        <>
          <div role="tablist" className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
            {series.map((s) => {
              const f = trendFormat(fmt, t, s.metric, dataSport);
              const v = changeVerdict(s, fmt, t, f);
              const active = s.metric === selected?.metric;
              return (
                <button
                  key={s.metric}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setPicked(s.metric)}
                  className={cn(
                    'min-w-0 rounded-control border px-3 py-2 text-left transition-colors',
                    active ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-2',
                  )}
                >
                  <div className="truncate text-xs font-medium text-fg-3">{trendMetricLabel(t, s.metric, dataSport)}</div>
                  <div className="mt-0.5 truncate text-sm font-semibold text-fg">{f.format(s.median.at(-1)!)}</div>
                  <div className="mt-0.5 truncate">
                    {v ? <ChangeBadge value={v.value} text={v.label} better={v.better} /> : <span className="text-xs text-fg-3">–</span>}
                  </div>
                </button>
              );
            })}
          </div>
          {selected && tf && (
            <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {verdict && <ChangeBadge value={verdict.value} text={verdict.label} better={verdict.better} className="text-sm" />}
              {selected.fit && (
                <span className="text-xs text-fg-3">
                  {t('progress.trends.summary', {
                    from: tf.format(selected.fit.startValue),
                    to: tf.format(selected.fit.endValue),
                    start: monthYearLabel(fmt, msDay(selected.fit.startTs * 1000)),
                    end: monthYearLabel(fmt, msDay(selected.fit.endTs * 1000)),
                  })}
                </span>
              )}
            </div>
          )}
          {option && <EChart option={option} height={HEIGHT} loading={q.isFetching} onEvents={onEvents} ariaLabel={t('progress.trends.title')} />}
          {selected && <p className="mt-2 text-xs text-fg-3">{t(`progress.trends.help.${selected.metric}`)}</p>}
        </>
      )}
    </ChartCard>
  );
}
