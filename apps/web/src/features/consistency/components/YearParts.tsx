import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Trophy, type LucideIcon } from 'lucide-react';
import { BEST_EFFORTS, workoutTitle, type YearReview, type YearWorkoutRef } from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { axisTooltip, barSeries, categoryAxis, grid, tooltipHtml, valueAxis } from '@/components/charts/options';
import { useChartTheme } from '@/components/charts/theme';
import { Badge, Card, Delta } from '@/components/ui';
import { useFormat, type Formatter } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { SportBadge, SportIcon, sportColorVar } from '@/lib/sports';
import { hourLabel, previousYearCovered } from '../lib';

/** The previous year misses more than a month of data: totals are not comparable. */
export function prevPartial(r: YearReview): boolean {
  return !!r.previous && !previousYearCovered(r.firstDay, r.year);
}

/** Relative change, null without a meaningful base. */
export function pctChange(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur === null || cur === undefined || prev === null || prev === undefined || prev === 0) return null;
  return (cur - prev) / Math.abs(prev);
}

/** "+12 %" delta (icon + status color by direction × whether up is good). */
export function PctDelta({ cur, prev, upIsGood = true }: { cur: number | null; prev: number | null; upIsGood?: boolean }) {
  const fmt = useFormat();
  const p = pctChange(cur, prev);
  if (p === null) return null;
  const text = `${p > 0 ? '+' : p < 0 ? '−' : '±'}${fmt.pct(Math.abs(p))}`;
  return <Delta value={Math.abs(p) < 0.005 ? 0 : p} text={text} upIsGood={upIsGood} />;
}

export function effortLabel(sport: string, effort: string, lang: 'en' | 'de'): string {
  return BEST_EFFORTS[sport]?.find((e) => e.key === effort)?.label[lang] ?? effort;
}

/** Big headline section: the year and its five key numbers with the change vs. the previous year. */
export function YearHero({ r, children }: { r: YearReview; children?: ReactNode }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const p = r.previous;
  const comparable = !!p && !prevPartial(r);
  const dist = fmt.distanceParts(r.totals.distanceM, 0);
  const elev = fmt.elevationParts(r.totals.elevationM);
  const tiles: { label: string; value: string; unit?: string; cur: number; prev: number | null }[] = [
    { label: t('consistency.year.activities'), value: fmt.int(r.totals.activities), cur: r.totals.activities, prev: p?.activities ?? null },
    { label: t('consistency.year.activeDays'), value: fmt.int(r.totals.activeDays), cur: r.totals.activeDays, prev: p?.activeDays ?? null },
    { label: t('consistency.year.hours'), value: fmt.int(r.totals.durationS / 3600), unit: 'h', cur: r.totals.durationS, prev: p?.durationS ?? null },
    { label: t('common.distance'), value: dist.value, unit: dist.unit, cur: r.totals.distanceM, prev: p?.distanceM ?? null },
    { label: t('common.elevation'), value: elev.value, unit: elev.unit, cur: r.totals.elevationM, prev: p?.elevationM ?? null },
  ];
  return (
    <section className="overflow-hidden rounded-card border border-border bg-accent-soft p-5 shadow-card sm:p-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-sm font-semibold uppercase tracking-wider text-accent-fg">{t('consistency.year.kicker')}</div>
          <div className="text-6xl font-bold tracking-tight text-fg sm:text-7xl">{r.year}</div>
          <p className="mt-1 text-sm text-fg-2">
            {r.complete ? t('consistency.year.complete') : t('consistency.year.soFar', { date: fmt.day(r.asOf, 'day') })}
          </p>
        </div>
        {children}
      </div>
      <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((x) => (
          <div key={x.label} className="min-w-0">
            <div className="truncate text-xs font-medium text-fg-2">{x.label}</div>
            <div className="mt-0.5 flex items-baseline gap-1">
              <span className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">{x.value}</span>
              {x.unit && <span className="text-sm font-medium text-fg-3">{x.unit}</span>}
            </div>
            {comparable && (
              <div className="mt-1 text-xs">
                <PctDelta cur={x.cur} prev={x.prev} />
              </div>
            )}
          </div>
        ))}
      </div>
      {p && (
        <p className="mt-5 text-xs text-fg-3">
          {!comparable
            ? t('consistency.year.prevPartial', { year: r.year - 1, date: fmt.day(r.firstDay!, 'day') })
            : r.complete
              ? t('consistency.year.vsPrev', { year: r.year - 1 })
              : t('consistency.year.vsPrevToDate', { year: r.year - 1, date: fmt.day(r.asOf, 'dayShort') })}
        </p>
      )}
    </section>
  );
}

/** Ranked bars of hours per sport (values printed, so the bars need no tooltip). */
export function SportBars({ r }: { r: YearReview }) {
  const fmt = useFormat();
  const { t } = useI18n();
  const max = Math.max(1, ...r.bySport.map((s) => s.durationS));
  return (
    <ul className="space-y-3">
      {r.bySport.map((s) => (
        <li key={s.sport} className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
            <SportBadge sport={s.sport} />
            <div className="text-xs tabular text-fg-2">
              <span className="text-sm font-semibold text-fg">{fmt.hours(s.durationS)}</span>
              {' · '}
              {t('common.activities', { count: s.count })}
              {s.distanceM > 0 && ` · ${fmt.distance(s.distanceM, 0)}`}
            </div>
          </div>
          <div className="mt-1.5 h-2 pl-[26px]">
            <div className="h-full rounded-r-full" style={{ width: `${Math.max(1.5, (s.durationS / max) * 100)}%`, background: sportColorVar(s.sport) }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Hours per month (one series). */
export function MonthsChart({ r }: { r: YearReview }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const theme = useChartTheme();
  // stable per formatter (fmt.monthNames builds a new array each call, which would rebuild the chart every render)
  const names = useMemo(() => fmt.monthNames('short'), [fmt]);
  const long = useMemo(() => fmt.monthNames('long'), [fmt]);
  const option = useMemo(
    () => ({
      grid: grid({ top: 12 }),
      tooltip: axisTooltip(
        theme,
        (params: unknown) => {
          const i = (params as { dataIndex: number }[])[0]?.dataIndex ?? 0;
          const m = r.months[i]!;
          return tooltipHtml(
            `${long[i]} ${r.year}`,
            [
              { color: theme.series[0]!, label: t('consistency.year.hours'), value: fmt.hours(m.durationS) },
              { color: theme.series[0]!, label: t('consistency.year.activities'), value: fmt.int(m.count) },
              { color: theme.series[0]!, label: t('common.distance'), value: fmt.distance(m.distanceM, 0) },
            ],
            theme,
          );
        },
        { axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(128,128,128,0.08)' } } },
      ),
      xAxis: categoryAxis(theme, names),
      // small years get half-hour ticks: print them as 0.5 h, not "1 h, 1 h"
      yAxis: valueAxis(theme, {
        axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => `${fmt.num(v, Number.isInteger(v) ? 0 : 1)} h` },
      }),
      series: [barSeries(theme, t('consistency.year.hours'), r.months.map((m) => Math.round((m.durationS / 3600) * 10) / 10), theme.series[0]!)],
    }),
    [r, theme, names, long, fmt, t],
  );
  return (
    <ChartCard
      title={t('consistency.year.months')}
      footer={
        r.topMonth
          ? t('consistency.year.topMonth', {
              month: long[Number(r.topMonth.month.slice(5)) - 1]!,
              hours: fmt.hours(r.topMonth.durationS),
              count: r.topMonth.count,
            })
          : undefined
      }
      table={{
        columns: [
          { key: 'month', label: t('common.month') },
          { key: 'count', label: t('consistency.year.activities'), numeric: true },
          { key: 'hours', label: t('consistency.year.hours'), numeric: true },
          { key: 'distance', label: t('common.distance'), numeric: true },
          { key: 'days', label: t('consistency.year.activeDays'), numeric: true },
        ],
        rows: r.months.map((m, i) => ({
          month: long[i],
          count: fmt.int(m.count),
          hours: fmt.hours(m.durationS),
          distance: fmt.distance(m.distanceM, 0),
          days: fmt.int(m.activeDays),
        })),
      }}
    >
      <EChart option={option} height={240} ariaLabel={t('consistency.year.months')} />
    </ChartCard>
  );
}

/** Activities per weekday (week order of the user) or per start hour. */
export function RhythmChart({ r, kind, weekStart }: { r: YearReview; kind: 'weekday' | 'hour'; weekStart: 0 | 1 }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const theme = useChartTheme();
  const labels =
    kind === 'weekday' ? fmt.weekdayNames(weekStart, 'short') : Array.from({ length: 24 }, (_, h) => String(h));
  const longLabels =
    kind === 'weekday' ? fmt.weekdayNames(weekStart, 'long') : Array.from({ length: 24 }, (_, h) => hourLabel(fmt, h));
  const values = kind === 'weekday' ? labels.map((_, i) => r.weekdays[(i + weekStart) % 7]!) : r.hours;
  const top = values.indexOf(Math.max(...values));
  const option = useMemo(
    () => ({
      grid: grid({ top: 12 }),
      tooltip: axisTooltip(
        theme,
        (params: unknown) => {
          const i = (params as { dataIndex: number }[])[0]?.dataIndex ?? 0;
          return tooltipHtml(longLabels[i]!, [{ color: theme.series[0]!, label: t('consistency.year.activities'), value: fmt.int(values[i]!) }], theme);
        },
        { axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(128,128,128,0.08)' } } },
      ),
      xAxis: categoryAxis(theme, labels, kind === 'hour' ? { axisLabel: { color: theme.muted, fontSize: 11, interval: 2 } } : undefined),
      yAxis: valueAxis(theme, { minInterval: 1 }),
      series: [barSeries(theme, t('consistency.year.activities'), values, theme.series[0]!)],
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [r, kind, weekStart, theme, fmt, t],
  );
  const total = values.reduce((a, b) => a + b, 0);
  const title = kind === 'weekday' ? t('consistency.year.weekdays') : t('consistency.year.hoursOfDay');
  return (
    <ChartCard
      title={title}
      footer={
        total > 0
          ? kind === 'weekday'
            ? t('consistency.year.topWeekday', { weekday: longLabels[top]!, count: values[top]! })
            : t('consistency.year.topHour', { hour: longLabels[top]!, count: values[top]! })
          : undefined
      }
      table={{
        columns: [
          { key: 'label', label: kind === 'weekday' ? t('consistency.punchcard.weekday') : t('consistency.punchcard.hour') },
          { key: 'count', label: t('consistency.year.activities'), numeric: true },
        ],
        rows: values.map((v, i) => ({ label: longLabels[i], count: fmt.int(v) })),
      }}
    >
      <EChart option={option} height={200} ariaLabel={title} />
    </ChartCard>
  );
}

/** One highlight (longest, biggest climb, …) linking to its activity. */
export function HighlightCard({
  icon: Icon,
  label,
  value,
  w,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  w: YearWorkoutRef;
}) {
  const { lang } = useI18n();
  const fmt = useFormat();
  return (
    <Card className="min-w-0">
      <div className="flex items-center gap-1.5 text-xs font-medium text-fg-3">
        <Icon size={14} aria-hidden />
        {label}
      </div>
      <div className="mt-1 text-3xl font-semibold tracking-tight text-fg">{value}</div>
      <Link to={`/activities/${w.id}`} className="mt-2 flex min-w-0 items-center gap-2 text-sm hover:underline">
        <span className="grid size-6 shrink-0 place-items-center rounded-full text-white" style={{ background: sportColorVar(w.sport) }}>
          <SportIcon sport={w.sport} size={13} />
        </span>
        <span className="truncate font-medium text-fg">{workoutTitle(w, lang)}</span>
      </Link>
      <div className="mt-0.5 pl-8 text-xs text-fg-3">{fmt.date(w.startTs, w.tzMin, 'day')}</div>
    </Card>
  );
}

/** "PR" marker — accent badge with an icon and a label. */
export function PrBadge() {
  const { t } = useI18n();
  return (
    <Badge tone="accent" icon={Trophy}>
      {t('consistency.year.pr')}
    </Badge>
  );
}

/** Pace/speed text of an effort. */
export function effortPace(fmt: Formatter, sport: string, distanceM: number, elapsedS: number): string {
  return fmt.pace(distanceM / elapsedS, sport);
}
