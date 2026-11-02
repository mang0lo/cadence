import { useMemo } from 'react';
import { CalendarRange } from 'lucide-react';
import type { EChartsOption, LineSeriesOption } from 'echarts';
import type { ProgressVolumeMetric, ProgressYoyResponse } from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { axisTooltip, grid, lineSeries, timeAxis, tooltipHtml, valueAxis } from '@/components/charts/options';
import { sportColor, useChartTheme, type ChartTheme } from '@/components/charts/theme';
import { Delta, EmptyState, ErrorState } from '@/components/ui';
import { useFormat, type Formatter } from '@/lib/format';
import { useI18n, useT, type TFunction } from '@/lib/i18n';
import { sportLabel } from '@/lib/sports';
import { useYoy } from '../api';
import { DAY_MS, msDay, chartLegend } from '../chart';
import { formatVolume, signedRounded, volumeAxisLabel, volumeChartValue } from '../format';
import { ChartSkeleton } from './common';

const HEIGHT = 330;
/** Reference leap year: every calendar date has a slot. */
const BASE = Date.UTC(2000, 0, 1);
const slotMs = (i: number) => BASE + i * DAY_MS;
const MONTH_END = [30, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];

function buildOption(
  data: ProgressYoyResponse,
  o: { theme: ChartTheme; fmt: Formatter; t: TFunction; metric: ProgressVolumeMetric; color: string },
): EChartsOption {
  const { theme, fmt, t, metric, color } = o;
  const current = data.years.at(-1)!.year;
  const conv = (v: number) => Math.round(volumeChartValue(fmt, metric, v) * 100) / 100;
  const colorOf = (year: number) => (year === current ? color : theme.muted);
  const series: LineSeriesOption[] = data.years.map((y) => {
    const isCurrent = y.year === current;
    const older = y.year < current - 1;
    return lineSeries(theme, String(y.year), y.cumulative.map((v, i) => [slotMs(i), conv(v)]), colorOf(y.year), {
      lineStyle: { width: isCurrent ? 2.5 : 1.5, color: colorOf(y.year), opacity: older ? 0.45 : 1, cap: 'round', join: 'round' },
      z: isCurrent ? 5 : 2,
      ...(isCurrent
        ? {
            endLabel: { show: true, formatter: '{a}', color: theme.fg2, fontSize: 11, fontWeight: 600 },
            markLine: {
              symbol: 'none',
              silent: true,
              lineStyle: { color: theme.axis, width: 1, type: 'solid' },
              label: { formatter: t('common.today'), color: theme.fg2, fontSize: 11, position: 'end' },
              data: [{ xAxis: slotMs(data.todayIndex) }],
            },
          }
        : {}),
    });
  });
  return {
    useUTC: true,
    grid: grid({ top: 40, right: 40 }),
    legend: chartLegend(theme, 'line', {
      data: [...data.years].reverse().map((y) => ({ name: String(y.year), itemStyle: { opacity: y.year < current - 1 ? 0.45 : 1, borderWidth: 0 } })),
    }),
    xAxis: timeAxis(theme, {
      min: BASE,
      max: slotMs(365),
      axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: (v: number) => fmt.day(msDay(v), 'monthShort') },
    }),
    yAxis: valueAxis(theme, { axisLabel: { color: theme.muted, fontSize: 11, formatter: (n: number) => volumeAxisLabel(fmt, metric, n) } }),
    tooltip: axisTooltip(theme, (params: unknown) => {
      const ps = params as { axisValue: number }[];
      const i = Math.round(((ps[0]?.axisValue ?? BASE) - BASE) / DAY_MS);
      const rows = [...data.years]
        .reverse()
        .filter((y) => y.cumulative[i] !== undefined)
        .map((y) => ({
          color: y.year < current - 1 ? theme.axis : colorOf(y.year),
          label: String(y.year),
          value: formatVolume(fmt, metric, y.cumulative[i]!),
        }));
      return tooltipHtml(fmt.day(msDay(slotMs(i)), 'dayShort'), rows, theme);
    }),
    series,
  } as EChartsOption;
}

export function YoyCard({ sport, metric }: { sport: string; metric: ProgressVolumeMetric }) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const { lang } = useI18n();
  const q = useYoy(sport, metric);
  const data = q.data;
  const color = sport === 'all' ? theme.accent : sportColor(theme, sport);
  const option = useMemo(
    () => (data?.years.length ? buildOption(data, { theme, fmt, t, metric, color }) : null),
    [data, theme, fmt, t, metric, color],
  );
  const sportName = sport === 'all' ? t('common.allSports') : sportLabel(sport, lang);
  const metricName = t(`progress.metricNames.${metric}`);

  const table = useMemo(() => {
    if (!data?.years.length) return undefined;
    const years = [...data.years].reverse();
    const currentYear = data.years.at(-1)!.year;
    const months = fmt.monthNames('long');
    const rows: Record<string, string>[] = [
      {
        month: t('common.today'),
        ...Object.fromEntries(years.map((y) => [String(y.year), formatVolume(fmt, metric, y.cumulative[data.todayIndex] ?? 0)])),
      },
      ...MONTH_END.map((end, m) => ({
        month: t('progress.yoy.endOf', { month: months[m]! }),
        ...Object.fromEntries(
          years.map((y) => [
            String(y.year),
            y.year === currentYear && end > data.todayIndex ? '–' : formatVolume(fmt, metric, y.cumulative[end] ?? 0),
          ]),
        ),
      })),
    ];
    return {
      columns: [
        { key: 'month', label: t('progress.yoy.month') },
        ...years.map((y) => ({ key: String(y.year), label: String(y.year), numeric: true })),
      ],
      rows,
    };
  }, [data, fmt, metric, t]);

  const c = data?.comparison;
  const headline = c ? (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <Delta
        value={c.diff}
        upIsGood
        className="text-sm"
        text={
          Math.abs(c.diff) < 1e-6
            ? t('progress.yoy.even', { year: c.previousYear })
            : t(c.diff > 0 ? 'progress.yoy.ahead' : 'progress.yoy.behind', {
                value: `${formatVolume(fmt, metric, Math.abs(c.diff))}${c.pct !== null ? ` (${signedRounded(fmt, c.pct * 100)} %)` : ''}`,
                year: c.previousYear,
              })
        }
      />
      <span className="text-xs text-fg-3">
        {t('progress.yoy.detail', {
          year: c.year,
          value: formatVolume(fmt, metric, c.value),
          previousYear: c.previousYear,
          date: fmt.day(data!.today, 'dayShort'),
          previousValue: formatVolume(fmt, metric, c.previousValue),
        })}
      </span>
    </div>
  ) : data?.years.length === 1 ? (
    <p className="mb-3 text-xs text-fg-3">{t('progress.yoy.firstYear')}</p>
  ) : null;

  return (
    <ChartCard
      title={t('progress.yoy.title')}
      subtitle={`${t('progress.yoy.subtitle', { metric: metricName })} · ${sportName}`}
      icon={CalendarRange}
      table={table}
    >
      {q.error ? (
        <ErrorState error={q.error} />
      ) : !data ? (
        <ChartSkeleton height={HEIGHT + 30} />
      ) : !option ? (
        <EmptyState title={t('progress.common.noActivities')} className="h-[360px]" />
      ) : (
        <>
          {headline}
          <EChart option={option} height={HEIGHT} loading={q.isFetching} ariaLabel={t('progress.yoy.title')} />
        </>
      )}
    </ChartCard>
  );
}
