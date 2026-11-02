import { useEffect, useMemo, useState } from 'react';
import { Flame } from 'lucide-react';
import type { EChartsOption } from 'echarts';
import type { ProgressIntensityResponse } from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { axisTooltip, categoryAxis, grid, stackedBarSeries, tooltipHtml, valueAxis } from '@/components/charts/options';
import { useChartTheme, type ChartTheme } from '@/components/charts/theme';
import { EmptyState, ErrorState, SegmentedControl } from '@/components/ui';
import { useFormat, type Formatter } from '@/lib/format';
import { useT, type TFunction } from '@/lib/i18n';
import { diffDays } from '@/lib/time';
import { useIntensity, type RangeParams } from '../api';
import { bucketLabel } from '../chart';
import { ChartSkeleton } from './common';

const HEIGHT = 260;

/** "Z2 Endurance · 125–141 bpm" from the zone upper bounds. */
export function zoneLabels(t: TFunction, bounds: number[]): string[] {
  return [0, 1, 2, 3, 4].map((i) => {
    const name = t(`common.zones.z${i + 1}`);
    if (bounds.length !== 4) return name;
    const range =
      i === 0
        ? t('progress.intensity.zoneRange.first', { hi: bounds[0]! })
        : i === 4
          ? t('progress.intensity.zoneRange.last', { lo: bounds[3]! })
          : t('progress.intensity.zoneRange.middle', { lo: bounds[i - 1]!, hi: bounds[i]! - 1 });
    return `${name} · ${range}`;
  });
}

function bucketTitle(fmt: Formatter, b: { key: string; fromDay: string; toDay: string }, bucket: 'week' | 'month'): string {
  return bucket === 'week' ? `${fmt.day(b.fromDay, 'dayShort')} – ${fmt.day(b.toDay, 'day')}` : bucketLabel(fmt, b.key, 'long');
}

function buildOption(data: ProgressIntensityResponse, o: { theme: ChartTheme; fmt: Formatter; t: TFunction; labels: string[] }): EChartsOption {
  const { theme, fmt, t, labels } = o;
  const hours = (s: number) => Math.round((s / 3600) * 100) / 100;
  return {
    grid: grid({ top: 12, right: 28 }),
    xAxis: categoryAxis(theme, data.buckets.map((b) => bucketLabel(fmt, b.key))),
    yAxis: valueAxis(theme, { axisLabel: { color: theme.muted, fontSize: 11, formatter: (n: number) => `${fmt.num(n, n % 1 ? 1 : 0)} h` } }),
    tooltip: axisTooltip(
      theme,
      (params: unknown) => {
        const i = (params as { dataIndex: number }[])[0]?.dataIndex ?? 0;
        const b = data.buckets[i]!;
        const rows = [4, 3, 2, 1, 0]
          .filter((z) => b.zones[z]! > 0)
          .map((z) => ({ color: theme.zones[z]!, label: labels[z]!, value: fmt.durationShort(b.zones[z]!) }));
        if (b.easyShare !== null)
          rows.push({ color: 'transparent', label: t('progress.intensity.easyShare'), value: fmt.pct(b.easyShare) });
        return tooltipHtml(bucketTitle(fmt, b, data.bucket), rows, theme);
      },
      { axisPointer: { type: 'shadow', shadowStyle: { color: theme.dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' } } },
    ),
    series: stackedBarSeries(
      theme,
      'zones',
      labels.map((name, z) => ({ name, color: theme.zones[z]!, data: data.buckets.map((b) => hours(b.zones[z]!)) })),
    ),
  } as EChartsOption;
}

export function IntensityCard({ sport, range }: { sport: string; range: RangeParams | null }) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const [picked, setPicked] = useState<'week' | 'month' | null>(null);
  useEffect(() => setPicked(null), [range?.fromDay]);
  const bucket = picked ?? (range && diffDays(range.fromDay, range.toDay) > 460 ? 'month' : 'week');
  const q = useIntensity(sport, bucket, range);
  const data = q.data;
  const labels = useMemo(() => zoneLabels(t, data?.zoneBounds ?? []), [t, data?.zoneBounds]);
  const option = useMemo(() => (data && data.totals.total > 0 ? buildOption(data, { theme, fmt, t, labels }) : null), [data, theme, fmt, t, labels]);
  const table = useMemo(() => {
    if (!data || !data.totals.total) return undefined;
    return {
      columns: [
        { key: 'period', label: t('progress.common.period') },
        ...labels.map((_, z) => ({ key: `z${z}`, label: `Z${z + 1}`, numeric: true })),
        { key: 'easy', label: t('progress.intensity.easyShare'), numeric: true },
      ],
      rows: [...data.buckets].reverse().map((b) => ({
        period: bucketTitle(fmt, b, data.bucket),
        ...Object.fromEntries(b.zones.map((s, z) => [`z${z}`, fmt.durationShort(s)])),
        easy: b.easyShare === null ? '–' : fmt.pct(b.easyShare),
      })),
    };
  }, [data, labels, fmt, t]);

  const tot = data?.totals;
  return (
    <ChartCard
      title={t('progress.intensity.title')}
      subtitle={t(`progress.intensity.subtitle.${bucket}`)}
      icon={Flame}
      table={table}
      actions={
        <SegmentedControl
          size="sm"
          value={bucket}
          onChange={setPicked}
          label={t('progress.common.period')}
          items={(['week', 'month'] as const).map((b) => ({ value: b, label: t(`progress.buckets.${b}`) }))}
        />
      }
      footer={data && data.coverage.workouts > 0 ? t('progress.intensity.coverage', { n: data.coverage.withZones, total: data.coverage.workouts }) : undefined}
    >
      {q.error ? (
        <ErrorState error={q.error} />
      ) : !data ? (
        <ChartSkeleton height={HEIGHT + 100} />
      ) : !option || !tot ? (
        <EmptyState title={t('progress.intensity.empty')} className="h-[360px]" />
      ) : (
        <>
          <div className="mb-3">
            <div
              className="flex h-2 w-full gap-[2px] overflow-hidden rounded-full"
              role="img"
              aria-label={`${t('progress.intensity.easy')} ${fmt.pct(tot.easyShare ?? 0)}, ${t('progress.intensity.hard')} ${fmt.pct(tot.hardShare ?? 0)}`}
            >
              {tot.zones.map((s, z) =>
                s > 0 ? <div key={z} style={{ width: `${(s / tot.total) * 100}%`, background: `var(--zone-${z + 1})` }} /> : null,
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
              <span>
                <span className="font-semibold text-fg">{fmt.pct(tot.easyShare ?? 0)}</span>{' '}
                <span className="text-fg-3">{t('progress.intensity.easy')}</span>
              </span>
              <span>
                <span className="font-semibold text-fg">{fmt.pct(tot.hardShare ?? 0)}</span>{' '}
                <span className="text-fg-3">{t('progress.intensity.hard')}</span>
              </span>
              <span className="text-xs text-fg-3">{t('progress.intensity.guideline')}</span>
            </div>
          </div>
          {/* HTML legend: five long zone labels would wrap over the plot inside the canvas */}
          <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
            {labels.map((l, z) => (
              <li key={z} className="flex items-center gap-1.5 text-xs text-fg-2">
                <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: `var(--zone-${z + 1})` }} aria-hidden />
                {l}
              </li>
            ))}
          </ul>
          <EChart option={option} height={HEIGHT} loading={q.isFetching} ariaLabel={t('progress.intensity.title')} />
        </>
      )}
    </ChartCard>
  );
}
