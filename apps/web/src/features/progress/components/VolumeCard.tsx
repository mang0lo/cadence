import { useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import type { EChartsOption } from 'echarts';
import type { ProgressBucket, ProgressVolumeBucket, ProgressVolumeMetric, ProgressVolumeResponse } from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import {
  axisTooltip,
  barSeries,
  categoryAxis,
  grid,
  lineSeries,
  stackedBarSeries,
  tooltipHtml,
  valueAxis,
} from '@/components/charts/options';
import { sportColor, useChartTheme, type ChartTheme } from '@/components/charts/theme';
import { EmptyState, ErrorState, SegmentedControl } from '@/components/ui';
import { useFormat, type Formatter } from '@/lib/format';
import { useI18n, useT, type TFunction } from '@/lib/i18n';
import { sportLabel } from '@/lib/sports';
import { useVolume, type RangeParams } from '../api';
import { bucketLabel, sportGroups, type SportGroup, chartLegend } from '../chart';
import { formatVolume, totalsValue, volumeAxisLabel, volumeChartValue } from '../format';
import { defaultBucket } from '../periods';
import { ChartSkeleton } from './common';

const HEIGHT = 300;

function bucketTitle(fmt: Formatter, b: ProgressVolumeBucket, bucket: ProgressBucket): string {
  if (bucket === 'week') return `${fmt.day(b.fromDay, 'dayShort')} – ${fmt.day(b.toDay, 'day')}`;
  return bucketLabel(fmt, b.key, 'long');
}

function groupValue(b: ProgressVolumeBucket, g: SportGroup, metric: ProgressVolumeMetric): number {
  return g.sports.reduce((s, sp) => s + totalsValue(b.bySport[sp], metric), 0);
}

function buildOption(
  data: ProgressVolumeResponse,
  opts: {
    theme: ChartTheme;
    fmt: Formatter;
    t: TFunction;
    metric: ProgressVolumeMetric;
    sport: string;
    groups: SportGroup[];
    sportName: string;
  },
): EChartsOption {
  const { theme, fmt, t, metric, sport, groups, sportName } = opts;
  const single = sport !== 'all';
  const conv = (v: number) => Math.round(volumeChartValue(fmt, metric, v) * 100) / 100;
  const cats = data.buckets.map((b) => bucketLabel(fmt, b.key));
  const avgName = data.rollingWindow ? t(`progress.volume.average.${data.bucket}`) : '';
  const rolling = data.rolling[metric];
  const series = single
    ? [
        barSeries(theme, sportName, data.buckets.map((b) => conv(totalsValue(b.total, metric))), sportColor(theme, sport)),
        ...(data.rollingWindow
          ? [
              lineSeries(theme, avgName, rolling.map((v) => (v === null ? null : conv(v))), theme.fg2, {
                z: 3,
                connectNulls: false,
              }),
            ]
          : []),
      ]
    : stackedBarSeries(
        theme,
        'volume',
        groups.map((g) => ({ name: g.label, color: g.color, data: data.buckets.map((b) => conv(groupValue(b, g, metric))) })),
      );
  const showLegend = series.length >= 2;
  return {
    grid: grid({ top: showLegend ? 40 : 16, right: 28 }),
    legend: showLegend ? chartLegend(theme, 'rect', { data: series.map((s) => ({ name: s.name, icon: s.type === 'line' ? 'path://M0,4 L14,4 L14,6 L0,6 Z' : 'roundRect' })) }) : undefined,
    xAxis: categoryAxis(theme, cats),
    yAxis: valueAxis(theme, { axisLabel: { color: theme.muted, fontSize: 11, formatter: (n: number) => volumeAxisLabel(fmt, metric, n) } }),
    tooltip: axisTooltip(
      theme,
      (params: unknown) => {
        const i = (params as { dataIndex: number }[])[0]?.dataIndex ?? 0;
        const b = data.buckets[i]!;
        const rows = single
          ? [
              { color: sportColor(theme, sport), label: sportName, value: formatVolume(fmt, metric, totalsValue(b.total, metric)) },
              ...(data.rollingWindow && rolling[i] !== null
                ? [{ color: theme.fg2, label: avgName, value: formatVolume(fmt, metric, rolling[i]!) }]
                : []),
            ]
          : [
              ...[...groups]
                .reverse()
                .filter((g) => groupValue(b, g, metric) > 0)
                .map((g) => ({ color: g.color, label: g.label, value: formatVolume(fmt, metric, groupValue(b, g, metric)) })),
              { color: 'transparent', label: t('progress.common.total'), value: formatVolume(fmt, metric, totalsValue(b.total, metric)) },
            ];
        return tooltipHtml(bucketTitle(fmt, b, data.bucket), rows, theme);
      },
      { axisPointer: { type: 'shadow', shadowStyle: { color: theme.dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' } } },
    ),
    series,
  } as EChartsOption;
}

export function VolumeCard({
  sport,
  metric,
  range,
}: {
  sport: string;
  metric: ProgressVolumeMetric;
  range: RangeParams | null;
}) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const { lang } = useI18n();
  // a picked bucket belongs to the period it was picked for; another period starts with its default bucket. Derived,
  // not reset in an effect: the render after a period change must not request the new period with the old bucket
  const [picked, setPicked] = useState<{ fromDay: string | undefined; bucket: ProgressBucket } | null>(null);
  const bucket = (picked?.fromDay === range?.fromDay ? picked?.bucket : undefined) ?? (range ? defaultBucket(range) : 'week');
  const q = useVolume(sport, bucket, range);
  const data = q.data;
  const sportName = sport === 'all' ? t('common.allSports') : sportLabel(sport, lang);
  const groups = useMemo(
    () => (data ? sportGroups(theme, data.sports, lang, t('progress.common.other')) : []),
    [data, theme, lang, t],
  );
  const option = useMemo(
    () => (data ? buildOption(data, { theme, fmt, t, metric, sport, groups, sportName }) : null),
    [data, theme, fmt, t, metric, sport, groups, sportName],
  );

  const table = useMemo(() => {
    if (!data) return undefined;
    const single = sport !== 'all';
    const columns = [
      { key: 'period', label: t('progress.common.period') },
      ...(single ? [] : groups.map((g) => ({ key: g.key, label: g.label, numeric: true }))),
      { key: 'total', label: single ? sportName : t('progress.common.total'), numeric: true },
      ...(single && data.rollingWindow ? [{ key: 'avg', label: t(`progress.volume.average.${data.bucket}`), numeric: true }] : []),
    ];
    const rows = data.buckets.map((b, i) => {
      const r: Record<string, string> = {
        period: bucketTitle(fmt, b, data.bucket),
        total: formatVolume(fmt, metric, totalsValue(b.total, metric)),
      };
      for (const g of groups) r[g.key] = formatVolume(fmt, metric, groupValue(b, g, metric));
      const avg = data.rolling[metric][i];
      if (avg !== null && avg !== undefined) r.avg = formatVolume(fmt, metric, avg);
      return r;
    });
    return { columns, rows: rows.reverse() };
  }, [data, groups, fmt, metric, sport, sportName, t]);

  const metricName = t(`progress.metricNames.${metric}`);
  const empty = data && data.totals.count === 0;
  return (
    <ChartCard
      title={t('progress.volume.title')}
      subtitle={`${t(`progress.volume.subtitle.${bucket}`, { metric: metricName })} · ${sportName}`}
      icon={BarChart3}
      table={empty ? undefined : table}
      actions={
        <SegmentedControl
          size="sm"
          value={bucket}
          onChange={(b) => setPicked({ fromDay: range?.fromDay, bucket: b })}
          label={t('progress.common.period')}
          items={(['week', 'month', 'year'] as const).map((b) => ({ value: b, label: t(`progress.buckets.${b}`) }))}
        />
      }
      footer={
        data && !empty
          ? t('progress.volume.footer', {
              value: formatVolume(fmt, metric, totalsValue(data.totals, metric)),
              count: t('progress.common.activityCount', { count: data.totals.count, n: fmt.int(data.totals.count) }),
            })
          : undefined
      }
    >
      {q.error ? (
        <ErrorState error={q.error} />
      ) : !data || !option ? (
        <ChartSkeleton height={HEIGHT} />
      ) : empty ? (
        <EmptyState title={t('progress.common.noActivities')} description={t('progress.common.noActivitiesHint')} className="h-[300px]" />
      ) : (
        <EChart option={option} height={HEIGHT} loading={q.isFetching} ariaLabel={t('progress.volume.title')} />
      )}
    </ChartCard>
  );
}
