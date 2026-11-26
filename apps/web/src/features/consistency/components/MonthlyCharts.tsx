import { useMemo } from 'react';
import { BarChart3, CircleDot } from 'lucide-react';
import type { CalendarResponse } from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { axisTooltip, barSeries, categoryAxis, grid, legend, lineSeries, tooltipHtml, valueAxis } from '@/components/charts/options';
import { useChartTheme } from '@/components/charts/theme';
import { EmptyState } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { RINGS, type Ring } from '../lib';

const months = (year: number) => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);

/** Active days per month for one calendar response (null for months after asOf). */
function activeDaysPerMonth(data: CalendarResponse | undefined, year: number, asOf: string): (number | null)[] {
  const counts = new Map<string, number>();
  for (const d of data?.days ?? []) if (d.count > 0) counts.set(d.day.slice(0, 7), (counts.get(d.day.slice(0, 7)) ?? 0) + 1);
  return months(year).map((m) => (`${m}-01` > asOf ? null : (counts.get(m) ?? 0)));
}

type AxisParam = { seriesName: string; value: number | null; color: string; dataIndex: number };

/** Active days per month of the selected year, next to the previous year (gray context). */
export function MonthlyActiveDays({
  year,
  asOf,
  cur,
  prev,
  loading,
}: {
  year: number;
  asOf: string;
  cur: CalendarResponse | undefined;
  prev: CalendarResponse | undefined;
  loading?: boolean;
}) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  // all memoized: new arrays on every render would rebuild the chart (setOption notMerge) on each page re-render
  const names = useMemo(() => fmt.monthNames('short'), [fmt]);
  const long = useMemo(() => fmt.monthNames('long'), [fmt]);
  const thisYear = useMemo(() => activeDaysPerMonth(cur, year, asOf), [cur, year, asOf]);
  const lastYear = useMemo(() => activeDaysPerMonth(prev, year - 1, asOf), [prev, year, asOf]);
  const hasPrev = lastYear.some((v) => (v ?? 0) > 0);
  const option = useMemo(
    () => ({
      grid: grid({ top: hasPrev ? 36 : 12 }),
      legend: hasPrev ? legend(theme, 'rect') : { show: false },
      tooltip: axisTooltip(
        theme,
        (params: unknown) => {
          const ps = params as AxisParam[];
          const i = ps[0]?.dataIndex ?? 0;
          return tooltipHtml(
            long[i]!,
            ps
              .filter((p) => p.value !== null && p.value !== undefined)
              .map((p) => ({ color: p.color, label: p.seriesName, value: t('common.days', { count: p.value! }) })),
            theme,
          );
        },
        { axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(128,128,128,0.08)' } } },
      ),
      xAxis: categoryAxis(theme, names),
      yAxis: valueAxis(theme, { minInterval: 1, max: 31 }),
      series: [
        ...(hasPrev ? [barSeries(theme, String(year - 1), lastYear, theme.other)] : []),
        barSeries(theme, String(year), thisYear, theme.series[0]!),
      ],
    }),
    [theme, names, long, thisYear, lastYear, hasPrev, year, t],
  );
  const total = thisYear.reduce<number>((s, v) => s + (v ?? 0), 0);
  return (
    <ChartCard
      title={t('consistency.months.title')}
      subtitle={hasPrev ? t('consistency.months.subtitle', { year, prev: year - 1 }) : t('common.days', { count: total })}
      icon={BarChart3}
      table={{
        columns: [
          { key: 'month', label: t('common.month') },
          ...(hasPrev ? [{ key: 'prev', label: String(year - 1), numeric: true }] : []),
          { key: 'cur', label: String(year), numeric: true },
        ],
        rows: months(year).map((_, i) => ({
          month: long[i],
          prev: lastYear[i] ?? '–',
          cur: thisYear[i] ?? '–',
        })),
      }}
    >
      {!cur ? (
        <div style={{ height: 260 }} />
      ) : (
        <EChart option={option} height={260} loading={loading} ariaLabel={t('consistency.months.title')} />
      )}
    </ChartCard>
  );
}

/** Share of days per month with each ring closed (one y-axis in %). */
export function RingClosureCard({
  year,
  data,
  loading,
}: {
  year: number;
  data: CalendarResponse | undefined;
  loading?: boolean;
}) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  // fixed entity → slot mapping (validated all-pairs): Move 1 · Exercise 3 · Stand 2
  const colors: Record<Ring, string> = { move: theme.series[0]!, exercise: theme.series[2]!, stand: theme.series[1]! };
  const stats = useMemo(() => {
    const per = new Map<string, { days: number } & Record<Ring, number>>();
    for (const d of data?.days ?? []) {
      if (d.move === null && d.exercise === null && d.stand === null) continue;
      const m = d.day.slice(0, 7);
      const s = per.get(m) ?? { days: 0, move: 0, exercise: 0, stand: 0 };
      s.days++;
      for (const r of RINGS) if ((d[r] ?? 0) >= 0.9999) s[r]++;
      per.set(m, s);
    }
    return months(year).map((m) => per.get(m) ?? null);
  }, [data, year]);
  const hasData = stats.some((s) => s && s.days > 0);
  const names = useMemo(() => fmt.monthNames('short'), [fmt]);
  const long = useMemo(() => fmt.monthNames('long'), [fmt]);
  const label = (r: Ring) => t(`consistency.rings.${r}`);
  const option = useMemo(
    () => ({
      grid: grid({ top: 36 }),
      legend: legend(theme, 'line'),
      tooltip: axisTooltip(theme, (params: unknown) => {
        const ps = params as AxisParam[];
        const i = ps[0]?.dataIndex ?? 0;
        const s = stats[i];
        return tooltipHtml(
          `${long[i]}${s ? ` · ${t('common.days', { count: s.days })}` : ''}`,
          ps.filter((p) => p.value !== null).map((p) => ({ color: p.color, label: p.seriesName, value: fmt.pct(p.value!) })),
          theme,
        );
      }),
      xAxis: categoryAxis(theme, names, { boundaryGap: false }),
      yAxis: valueAxis(theme, { min: 0, max: 1, interval: 0.25, axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => fmt.pct(v) } }),
      series: RINGS.map((r) =>
        lineSeries(theme, label(r), stats.map((s) => (s && s.days ? s[r] / s.days : null)), colors[r], {
          showSymbol: true,
          connectNulls: false,
        }),
      ),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [theme, stats, names, long, fmt, t],
  );
  return (
    <ChartCard
      title={t('consistency.rings.closure')}
      subtitle={t('consistency.rings.closureSubtitle')}
      icon={CircleDot}
      table={{
        columns: [
          { key: 'month', label: t('common.month') },
          ...RINGS.map((r) => ({ key: r, label: label(r), numeric: true })),
          { key: 'days', label: t('consistency.rings.days'), numeric: true },
        ],
        rows: stats.flatMap((s, i) =>
          s && s.days
            ? [
                {
                  month: long[i],
                  move: fmt.pct(s.move / s.days),
                  exercise: fmt.pct(s.exercise / s.days),
                  stand: fmt.pct(s.stand / s.days),
                  days: fmt.int(s.days),
                },
              ]
            : [],
        ),
      }}
    >
      {!data ? (
        <div style={{ height: 260 }} />
      ) : hasData ? (
        <EChart option={option} height={260} loading={loading} ariaLabel={t('consistency.rings.closure')} />
      ) : (
        <EmptyState className="py-10" title={t('consistency.rings.noData')} />
      )}
    </ChartCard>
  );
}
