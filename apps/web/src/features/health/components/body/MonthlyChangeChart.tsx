import { useMemo } from 'react';
import { CalendarRange } from 'lucide-react';
import { mean, monthlyAverages, roundTo, type DayValue } from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { axisTooltip, barSeries, categoryAxis, grid, tooltipHtml, valueAxis } from '@/components/charts/options';
import { useChartTheme } from '@/components/charts/theme';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useMetricFormat } from '../../lib/metrics';

/**
 * Monthly change of a slowly moving measure (weight): bars of "mean of this month − mean of the previous calendar
 * month". One hue; the sign is carried by the bar direction, the axis and the signed tooltip text.
 */
export function MonthlyChangeChart({
  points,
  fromDay,
  metric,
  unit,
  color,
  title,
  subtitle,
}: {
  /** All measurements (the first visible month needs the month before it). */
  points: DayValue[];
  fromDay?: string;
  metric: string;
  unit?: string | null;
  color: string;
  title: string;
  subtitle: string;
}) {
  const t = useT();
  const fmt = useFormat();
  const m = useMetricFormat();
  const theme = useChartTheme();
  const spec = m.spec(metric, unit);
  const unitLabel = spec.unit;
  // all conversions are affine: a change converts without the offset
  const dConv = (v: number) => spec.convert(v) - spec.convert(0);
  const digits = spec.digits ?? 1;

  const months = useMemo(() => {
    const all = monthlyAverages(points);
    const from = fromDay?.slice(0, 7);
    return all.filter((x) => !from || x.month >= from);
  }, [points, fromDay]);

  const option = useMemo(() => {
    const labels = months.map((x) => fmt.day(`${x.month}-01`, 'monthYearShort'));
    const data = months.map((x) => {
      if (x.change === null) return { value: null, itemStyle: {} };
      const v = roundTo(dConv(x.change), digits + 1);
      return { value: v, itemStyle: v < 0 ? { borderRadius: [0, 0, 4, 4] } : {} };
    });
    const s = barSeries(theme, t('health.body.monthly.change'), data as never, color, { barMaxWidth: 24 });
    return {
      grid: grid({ top: 12 }),
      tooltip: axisTooltip(
        theme,
        (params) => {
          const p = (params as { dataIndex: number }[])[0];
          const x = p ? months[p.dataIndex] : undefined;
          if (!x) return '';
          const rows = [
            {
              color,
              label: t('health.body.monthly.change'),
              value: x.change === null ? '–' : m.delta(metric, x.change, unit).text,
            },
            { color, label: t('health.body.monthly.average'), value: m.value(metric, x.mean, unit) },
          ];
          return tooltipHtml(fmt.day(`${x.month}-01`, 'month'), rows, theme);
        },
        { axisPointer: { type: 'shadow', shadowStyle: { color: theme.grid, opacity: 0.35 } } },
      ),
      xAxis: categoryAxis(theme, labels, { axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true } }),
      yAxis: valueAxis(theme, {
        axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => fmt.num(v, 1) },
      }),
      series: [s],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [months, theme, fmt, color, m.units]);

  const changes = months.flatMap((x) => (x.change === null ? [] : [x.change]));
  const avgChange = mean(changes);

  return (
    <ChartCard
      title={`${title}${unitLabel ? ` (${unitLabel})` : ''}`}
      subtitle={subtitle}
      icon={CalendarRange}
      table={
        months.length
          ? {
              columns: [
                { key: 'month', label: t('health.common.date') },
                { key: 'avg', label: t('health.body.monthly.average'), numeric: true },
                { key: 'change', label: t('health.body.monthly.change'), numeric: true },
              ],
              rows: [...months].reverse().map((x) => ({
                month: fmt.day(`${x.month}-01`, 'month'),
                avg: m.value(metric, x.mean, unit),
                change: x.change === null ? '–' : m.delta(metric, x.change, unit).text,
              })),
            }
          : undefined
      }
      footer={
        avgChange !== null ? (
          <span>
            {t('health.body.monthly.avgChange', { value: m.delta(metric, avgChange, unit).text })}
          </span>
        ) : undefined
      }
    >
      {changes.length === 0 ? (
        <p className="py-10 text-center text-sm text-fg-3">{t('health.common.noDataRange')}</p>
      ) : (
        <EChart option={option} height={250} ariaLabel={title} />
      )}
    </ChartCard>
  );
}
