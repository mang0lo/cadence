import { useMemo } from 'react';
import { Clock } from 'lucide-react';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { categoryAxis, grid, itemTooltip, scatterSeries, tooltipHtml } from '@/components/charts/options';
import { useChartTheme } from '@/components/charts/theme';
import { EmptyState, ErrorState } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { usePunchcard } from '../api';
import { hourLabel } from '../lib';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const NO_CELLS: never[] = [];

/** Weekday × start hour of activities (dot area ∝ count), weekdays in the user's week order. */
export function PunchcardCard({ year, weekStart }: { year: number | 'all'; weekStart: 0 | 1 }) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const q = usePunchcard(year);
  // stable arrays, so the chart option is only rebuilt when something changed
  const short = useMemo(() => fmt.weekdayNames(weekStart, 'short'), [fmt, weekStart]);
  const long = useMemo(() => fmt.weekdayNames(weekStart, 'long'), [fmt, weekStart]);
  const hh = (h: number) => hourLabel(fmt, h);
  const cells = q.data?.cells ?? NO_CELLS;
  const max = Math.max(1, ...cells.map((c) => c.count));
  const row = (weekday: number) => (weekday - weekStart + 7) % 7;
  const busiest = [...cells].sort((a, b) => b.count - a.count)[0];

  const option = useMemo(
    () => ({
      grid: grid({ top: 8, left: 4, right: 8 }),
      tooltip: itemTooltip(theme, (p: unknown) => {
        const v = (p as { value: [number, number, number, number] }).value;
        return tooltipHtml(
          `${long[v[1]]}, ${hh(v[0])}–${hh((v[0] + 1) % 24)}`,
          [
            { color: theme.series[0]!, label: t('consistency.punchcard.count'), value: fmt.int(v[2]) },
            { color: theme.series[0]!, label: t('consistency.punchcard.time'), value: fmt.durationShort(v[3]) },
          ],
          theme,
        );
      }),
      xAxis: categoryAxis(theme, HOURS.map(String), {
        axisLabel: { color: theme.muted, fontSize: 11, interval: 2 },
        splitLine: { show: true, lineStyle: { color: theme.grid, width: 1 } },
      }),
      yAxis: categoryAxis(theme, short, {
        inverse: true,
        axisLine: { show: false },
        splitLine: { show: true, lineStyle: { color: theme.grid, width: 1 } },
      }),
      series: [
        scatterSeries(
          theme,
          t('consistency.punchcard.count'),
          cells.map((c) => [c.hour, row(c.weekday), c.count, c.durationS]),
          theme.series[0]!,
          { symbolSize: (v: number[]) => 6 + 20 * Math.sqrt(v[2]! / max) },
        ),
      ],
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cells, theme, short, long, max, fmt, t],
  );

  return (
    <ChartCard
      title={t('consistency.punchcard.title')}
      subtitle={
        busiest
          ? t('consistency.punchcard.busiest', { weekday: long[row(busiest.weekday)]!, hour: hh(busiest.hour) })
          : t('consistency.punchcard.subtitle')
      }
      icon={Clock}
      table={{
        columns: [
          { key: 'weekday', label: t('consistency.punchcard.weekday') },
          { key: 'hour', label: t('consistency.punchcard.hour') },
          { key: 'count', label: t('consistency.punchcard.count'), numeric: true },
          { key: 'time', label: t('consistency.punchcard.time'), numeric: true },
        ],
        rows: [...cells]
          .sort((a, b) => b.count - a.count || row(a.weekday) - row(b.weekday) || a.hour - b.hour)
          .map((c) => ({
            weekday: long[row(c.weekday)],
            hour: `${hh(c.hour)}–${hh((c.hour + 1) % 24)}`,
            count: fmt.int(c.count),
            time: fmt.durationShort(c.durationS),
          })),
      }}
    >
      {q.error ? (
        <ErrorState error={q.error} />
      ) : !q.data ? (
        <div style={{ height: 260 }} />
      ) : cells.length === 0 ? (
        <EmptyState className="py-10" title={t('consistency.calendar.noActivity')} />
      ) : (
        <EChart option={option} height={260} loading={q.isFetching} ariaLabel={t('consistency.punchcard.title')} />
      )}
    </ChartCard>
  );
}
