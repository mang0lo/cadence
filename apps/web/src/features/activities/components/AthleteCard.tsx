import { lazy, Suspense, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Activity, BarChart3, Settings, Table2, Trophy } from 'lucide-react';
import { sportInfo, type ActivitiesSummary, type ActivityTotals } from '@cadence/shared';
import { barSeries, categoryAxis, itemTooltip, tooltipHtml, valueAxis } from '@/components/charts/options';
import { sportColor, useChartTheme } from '@/components/charts/theme';
import { Card, IconButton, SegmentedControl, Skeleton, Table, TD, TH } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { sportIcon, sportLabel, sortSports } from '@/lib/sports';
import { todayKey } from '@/lib/time';
import { initials, minutesAxis, minutesTick, weekdayShort } from '../lib/display';
import { WidgetBoundary } from './WidgetBoundary';

// ECharts (~680 KB) is not needed to show the dashboard: the week chart loads it after the first paint
const EChart = lazy(() => import('@/components/charts/EChart').then((m) => ({ default: m.EChart })));
const WEEK_CHART_HEIGHT = 96;

function WeekChart({ summary }: { summary: ActivitiesSummary }) {
  const theme = useChartTheme();
  const fmt = useFormat();
  const { t, lang } = useI18n();
  const today = todayKey();
  const option = useMemo(() => {
    const labels = summary.week.map((d) => weekdayShort(d.day, fmt));
    const minutes = summary.week.map((d) => Math.round(d.totals.movingS / 60));
    // ticks of 15 / 30 min or whole hours: every label is exact
    const axis = minutesAxis(Math.max(0, ...minutes));
    return {
      grid: { left: 0, right: 0, top: 8, bottom: 0, containLabel: true },
      xAxis: categoryAxis(theme, labels, {
        axisLabel: {
          color: theme.muted,
          fontSize: 10,
          interval: 0,
          hideOverlap: true,
          formatter: (v: string, i: number) => (summary.week[i]?.day === today ? `{b|${v}}` : v),
          rich: { b: { color: theme.fg, fontWeight: 600, fontSize: 10 } },
        },
      }),
      yAxis: valueAxis(theme, {
        min: 0,
        max: axis.max,
        interval: axis.interval,
        axisLabel: { color: theme.muted, fontSize: 10, formatter: (v: number) => minutesTick(v, fmt) },
      }),
      tooltip: itemTooltip(theme, (p: unknown) => {
        const d = summary.week[(p as { dataIndex: number }).dataIndex]!;
        const rows = d.sports.length
          ? sortSports(d.sports.map((s) => s.sport)).map((sport) => {
              const s = d.sports.find((x) => x.sport === sport)!;
              return {
                color: sportColor(theme, sport),
                value: `${fmt.durationShort(s.movingS)}${s.distanceM > 0 ? ` · ${fmt.distance(s.distanceM)}` : ''}`,
                label: sportLabel(sport, lang),
              };
            })
          : [{ color: theme.axis, value: '–', label: t('activities.athlete.noActivityToday') }];
        return tooltipHtml(fmt.day(d.day, 'weekday'), rows, theme);
      }),
      series: [
        barSeries(theme, t('activities.athlete.weekChart'), minutes, theme.accent, { barMaxWidth: 16 }),
      ],
    };
  }, [summary, theme, fmt, t, lang, today]);
  // the same numbers as a table when the chart cannot be loaded
  return (
    <WidgetBoundary fallback={<WeekTable summary={summary} />}>
      <Suspense fallback={<div style={{ height: WEEK_CHART_HEIGHT }} aria-hidden />}>
        <EChart option={option} height={WEEK_CHART_HEIGHT} ariaLabel={t('activities.athlete.weekChart')} />
      </Suspense>
    </WidgetBoundary>
  );
}

function WeekTable({ summary }: { summary: ActivitiesSummary }) {
  const fmt = useFormat();
  const { t } = useI18n();
  return (
    <Table>
      <thead>
        <tr>
          <TH>{t('common.day')}</TH>
          <TH numeric>{t('activities.athlete.count')}</TH>
          <TH numeric>{t('common.movingTime')}</TH>
          <TH numeric>{t('common.distance')}</TH>
        </tr>
      </thead>
      <tbody>
        {summary.week.map((d) => (
          <tr key={d.day}>
            <TD>{fmt.day(d.day, 'weekdayShort')}</TD>
            <TD numeric>{d.totals.count}</TD>
            <TD numeric>{d.totals.count ? fmt.durationShort(d.totals.movingS) : '–'}</TD>
            <TD numeric>{d.totals.distanceM > 0 ? fmt.distance(d.totals.distanceM) : '–'}</TD>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function TotalsTable({ sport, summary }: { sport: string; summary: ActivitiesSummary }) {
  const fmt = useFormat();
  const { t } = useI18n();
  const entry = summary.sports.find((s) => s.sport === sport);
  const year: ActivityTotals = sport === 'all' ? summary.thisYear : (entry?.thisYear ?? summary.thisYear);
  const all: ActivityTotals = sport === 'all' ? summary.allTime : (entry?.allTime ?? summary.allTime);
  const showDistance = sport === 'all' ? all.distanceM > 0 : sportInfo(sport).distance && all.distanceM > 0;
  type Row = [label: string, unit: string, value: (x: ActivityTotals) => string];
  const rows: Row[] = [
    [t('activities.athlete.count'), '', (x) => fmt.int(x.count)],
    ...(showDistance
      ? [[t('common.distance'), fmt.distanceUnit, (x: ActivityTotals) => fmt.distanceParts(x.distanceM, 0).value] as Row]
      : []),
    [t('common.movingTime'), 'h', (x) => fmt.num(x.movingS / 3600)],
    ...(all.elevationM >= 1
      ? [[t('common.elevationGain'), fmt.elevationParts(0).unit, (x: ActivityTotals) => fmt.elevationParts(x.elevationM).value] as Row]
      : []),
  ];
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-fg-3">
          <th className="pb-1 text-left font-medium">
            <span className="sr-only">{t('activities.athlete.sportTotals')}</span>
          </th>
          <th className="pb-1 pl-2 text-right font-medium">{t('activities.athlete.thisYear')}</th>
          <th className="pb-1 pl-2 text-right font-medium">{t('activities.athlete.allTime')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, unit, f]) => (
          <tr key={label}>
            <td className="py-0.5 text-fg-3">
              {label}
              {unit && <span className="text-xs"> ({unit})</span>}
            </td>
            <td className="py-0.5 pl-2 text-right font-medium tabular text-fg">{f(year)}</td>
            <td className="py-0.5 pl-2 text-right font-medium tabular text-fg">{f(all)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Left column of the dashboard: who, totals, this week. */
export function AthleteCard({ summary }: { summary: ActivitiesSummary }) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const [sport, setSport] = useState('all');
  const [table, setTable] = useState(false);
  const top = summary.sports.slice(0, 4).map((s) => s.sport);
  const name = summary.athleteName || t('activities.titles.HomePage');
  const week = summary.thisWeek;
  return (
    <Card className="min-w-0">
      <div className="flex items-start gap-3">
        <span className="grid size-12 shrink-0 place-items-center rounded-full bg-accent-soft text-base font-semibold text-accent-fg">
          {initials(summary.athleteName)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-fg">{name}</div>
          <div className="text-xs text-fg-3">
            {t('activities.athlete.activities', { count: summary.allTime.count, n: fmt.int(summary.allTime.count) })}
          </div>
          {summary.firstActivityDay && (
            // the first activity's own local day, whatever the browser's time zone
            <div className="text-xs text-fg-3">
              {t('activities.athlete.since', { date: fmt.day(summary.firstActivityDay, 'month') })}
            </div>
          )}
        </div>
        <Link
          to="/settings"
          aria-label={t('activities.athlete.editProfile')}
          title={t('activities.athlete.editProfile')}
          className="grid size-8 shrink-0 place-items-center rounded-control text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <Settings size={16} />
        </Link>
      </div>

      <div className="mt-4 border-t border-border pt-3">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">{t('activities.athlete.thisWeek')}</h2>
          <IconButton
            icon={table ? BarChart3 : Table2}
            label={table ? t('common.showChart') : t('common.showTable')}
            onClick={() => setTable((v) => !v)}
          />
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 text-sm text-fg-2">
          <span className="font-semibold text-fg">{t('common.activities', { count: week.count })}</span>
          {week.count > 0 && <span className="tabular">{fmt.durationShort(week.movingS)}</span>}
          {week.distanceM > 0 && <span className="tabular">{fmt.distance(week.distanceM)}</span>}
        </div>
        <div className="mb-2 text-xs text-fg-3">
          {t('activities.athlete.lastWeek', {
            value: `${t('common.activities', { count: summary.lastWeek.count })} · ${fmt.durationShort(summary.lastWeek.movingS)}`,
          })}
        </div>
        {table ? <WeekTable summary={summary} /> : <WeekChart summary={summary} />}
      </div>

      {summary.sports.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <SegmentedControl
            size="sm"
            value={top.includes(sport) ? sport : 'all'}
            onChange={setSport}
            label={t('activities.athlete.sportTotals')}
            className="mb-3"
            items={[
              { value: 'all', label: t('common.all'), icon: Activity },
              ...top.map((s) => ({
                value: s,
                label: <span className="sr-only sm:not-sr-only lg:sr-only">{sportLabel(s, lang)}</span>,
                icon: sportIcon(s),
              })),
            ]}
          />
          <div className="mb-1 text-xs font-medium text-fg-2">
            {sport === 'all' ? t('common.allSports') : sportLabel(sport, lang)}
          </div>
          <TotalsTable sport={top.includes(sport) ? sport : 'all'} summary={summary} />
        </div>
      )}

      {summary.recentPrs > 0 && (
        <div className="mt-4 flex items-center gap-2 border-t border-border pt-3 text-sm text-fg-2">
          <Trophy size={16} className="shrink-0 text-accent-fg" aria-hidden />
          {t('activities.athlete.recentPrs', { count: summary.recentPrs })}
        </div>
      )}
    </Card>
  );
}

export function AthleteCardSkeleton() {
  return (
    <Card>
      <div className="flex gap-3">
        <Skeleton className="size-12 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
      <Skeleton className="mt-5 h-32 w-full" />
      <Skeleton className="mt-4 h-28 w-full" />
    </Card>
  );
}
