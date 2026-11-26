import { useMemo, useState } from 'react';
import { sportInfo } from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import {
  axisTooltip,
  grid,
  legend,
  lineSeries,
  timeAxis,
  tooltipHtml,
  valueAxis,
} from '@/components/charts/options';
import { sportColor, useChartTheme } from '@/components/charts/theme';
import { SegmentedControl } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { effortScale, effortSeries, type EffortMetric, type TrendEffort } from '../lib/effortTrend';

export type { TrendEffort };

/**
 * Time (or pace / speed) of repeated efforts over the calendar, with the running best as a step line. For times and
 * paces the axis is inverted, so an improvement always reads as "up".
 */
export function EffortTrend({
  efforts,
  sport,
  title,
  subtitle,
}: {
  efforts: TrendEffort[];
  sport: string;
  title: string;
  subtitle?: string;
}) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  // the efforts carry the sport's fixed color, the running best is a neutral step line
  const effortColor = sportColor(theme, sport);
  const bestColor = theme.fg2;
  const mode = sportInfo(sport).speedMode;
  const paceLike = mode === 'pace' || mode === 'pace100';
  const [metric, setMetric] = useState<EffortMetric>('time');
  const asc = useMemo(() => [...efforts].sort((a, b) => a.startTs - b.startTs), [efforts]);

  // swims per 100 m / 100 yd, runs per km / mi, rides in km/h / mph (tooltip and table with the unit)
  const scale = useMemo(() => effortScale(fmt, sport, metric), [fmt, sport, metric]);
  const { lowerIsBetter, label } = scale;
  const metricName =
    metric === 'time' ? t('maps.routes.time') : paceLike ? t('common.pace') : t('common.speed');

  const { points, bestSoFar } = useMemo(() => effortSeries(asc, scale), [asc, scale]);

  const option = useMemo(() => {
    const effortName = t('maps.routes.effort');
    const bestName = t('maps.routes.bestSoFar');
    return {
      grid: grid({ top: 34 }),
      legend: legend(theme, 'line', { itemStyle: { borderWidth: 0 } }),
      tooltip: axisTooltip(theme, (params) => {
        const ps = params as { seriesName: string; dataIndex: number; value: [number, number] }[];
        const eff = ps.find((p) => p.seriesName === effortName);
        const e = eff ? asc[eff.dataIndex] : undefined;
        if (!e || !eff) return '';
        const v = eff.value[1] as number | null;
        const rows = [{ color: effortColor, label: effortName, value: v == null ? '–' : label(v) }];
        const bs = ps.find((p) => p.seriesName === bestName);
        if (bs) rows.push({ color: bestColor, label: bestName, value: label(bs.value[1]) });
        rows.push({
          color: theme.muted,
          label: t('maps.routes.rankN', { rank: e.rank }),
          value: e.avgHr ? fmt.hr(e.avgHr) : '–',
        });
        return tooltipHtml(fmt.date(e.startTs, e.tzMin, 'day'), rows, theme);
      }),
      xAxis: timeAxis(theme),
      yAxis: valueAxis(theme, {
        scale: true,
        inverse: lowerIsBetter,
        axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => scale.axisLabel(v) },
      }),
      series: [
        lineSeries(theme, effortName, points, effortColor, {
          showSymbol: true,
          symbolSize: 8,
          lineStyle: { width: 1, color: effortColor, opacity: 0.45 },
        }),
        lineSeries(theme, bestName, bestSoFar, bestColor, {
          step: 'end',
          lineStyle: { width: 2, color: bestColor },
        }),
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, bestSoFar, theme, scale, fmt, asc, t, effortColor, bestColor]);

  return (
    <ChartCard
      title={title}
      subtitle={subtitle}
      actions={
        <SegmentedControl
          size="sm"
          value={metric}
          onChange={setMetric}
          label={t('maps.routes.metric')}
          items={[
            { value: 'time', label: t('maps.routes.time') },
            { value: 'pace', label: paceLike ? t('common.pace') : t('common.speed') },
          ]}
        />
      }
      table={{
        columns: [
          { key: 'date', label: t('common.day') },
          { key: 'v', label: metricName, numeric: true },
          { key: 'best', label: t('maps.routes.bestSoFar'), numeric: true },
          { key: 'rank', label: t('maps.routes.rank'), numeric: true },
        ],
        rows: asc.map((e, i) => ({
          date: fmt.date(e.startTs, e.tzMin, 'day'),
          v: points[i]![1] == null ? '–' : label(points[i]![1]!),
          best: (() => {
            const b = bestSoFar.filter((p) => p[0] <= e.startTs * 1000).pop();
            return b ? label(b[1]) : '–';
          })(),
          rank: String(e.rank),
        })),
      }}
    >
      <EChart option={option as never} height={300} ariaLabel={title} />
    </ChartCard>
  );
}
