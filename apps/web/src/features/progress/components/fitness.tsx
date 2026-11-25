import { useMemo } from 'react';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  ArrowDownRight,
  CheckCircle2,
  Gauge,
  HeartPulse,
  TrendingUp,
  Waves,
  type LucideIcon,
} from 'lucide-react';
import type { EChartsOption } from 'echarts';
import type {
  ProgressAcwrStatus,
  ProgressDailySeries,
  ProgressFitnessResponse,
  ProgressFormZone,
  ProgressPhysiology,
  ProgressRampStatus,
  ProgressVo2Level,
} from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import {
  areaSeries,
  axisTooltip,
  barSeries,
  categoryAxis,
  grid,
  itemTooltip,
  lineSeries,
  scatterSeries,
  timeAxis,
  tooltipHtml,
  valueAxis,
} from '@/components/charts/options';
import { useChartTheme, type ChartTheme } from '@/components/charts/theme';
import { Badge, Card, EmptyState, ErrorState, Hint, Stat } from '@/components/ui';
import { useFormat, type Formatter } from '@/lib/format';
import { useT, type TFunction } from '@/lib/i18n';
import { bucketLabel, chartLegend, dayMs, timeAxisLabel } from '../chart';
import { signedRounded } from '../format';
import { ChartSkeleton } from './common';
import { FormZoneBadge, type BadgeTone } from './FormZoneBadge';

const RAMP_STYLE: Record<ProgressRampStatus, { tone: BadgeTone; icon: LucideIcon }> = {
  normal: { tone: 'neutral', icon: CheckCircle2 },
  elevated: { tone: 'warning', icon: AlertTriangle },
  high: { tone: 'critical', icon: AlertOctagon },
};

const ACWR_STYLE: Record<ProgressAcwrStatus, { tone: BadgeTone; icon: LucideIcon }> = {
  low: { tone: 'neutral', icon: ArrowDownRight },
  optimal: { tone: 'good', icon: CheckCircle2 },
  elevated: { tone: 'warning', icon: AlertTriangle },
  high: { tone: 'critical', icon: AlertOctagon },
};

const signed1 = (fmt: Formatter, v: number) => signedRounded(fmt, v, Math.abs(v) < 10 ? 1 : 0);

// ---------------------------------------------------------------------------
// Stat tiles
// ---------------------------------------------------------------------------

export function FitnessStats({ data }: { data: ProgressFitnessResponse }) {
  const t = useT();
  const fmt = useFormat();
  const c = data.current;
  if (!c) return null;
  const th = data.thresholds;
  return (
    <Card>
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 xl:grid-cols-5">
        <Stat
          label={t('progress.fitness.stats.fitness')}
          value={fmt.int(c.ctl)}
          hint={t('progress.fitness.hints.fitness', { days: data.constants.ctlDays })}
        />
        <Stat
          label={t('progress.fitness.stats.fatigue')}
          value={fmt.int(c.atl)}
          hint={t('progress.fitness.hints.fatigue', { days: data.constants.atlDays })}
        />
        <Stat
          label={t('progress.fitness.stats.form')}
          value={fmt.signed(Math.round(c.tsb))}
          delta={
            <Hint content={t(`progress.fitness.zoneHelp.${c.zone}`)}>
              <FormZoneBadge zone={c.zone} />
            </Hint>
          }
          hint={t('progress.fitness.hints.form')}
        />
        <Stat
          label={t('progress.fitness.stats.ramp')}
          value={t('progress.units.perWeek', { value: signed1(fmt, c.ramp) })}
          delta={
            <Hint content={t('progress.fitness.rampHelp', { elevated: th.rampElevated, high: th.rampHigh })}>
              <Badge tone={RAMP_STYLE[c.rampStatus].tone} icon={RAMP_STYLE[c.rampStatus].icon}>
                {t(`progress.fitness.ramp.${c.rampStatus}`)}
              </Badge>
            </Hint>
          }
          hint={t('progress.fitness.hints.ramp')}
        />
        <Stat
          label={t('progress.fitness.stats.acwr')}
          value={c.acwr === null ? '–' : fmt.num(c.acwr, 2)}
          delta={
            c.acwrStatus ? (
              <Badge tone={ACWR_STYLE[c.acwrStatus].tone} icon={ACWR_STYLE[c.acwrStatus].icon}>
                {t(`progress.fitness.acwr.${c.acwrStatus}`)}
              </Badge>
            ) : undefined
          }
          hint={t('progress.fitness.hints.acwr')}
        />
      </div>
      <p className="mt-4 border-t border-border pt-3 text-sm text-fg-2">{t(`progress.fitness.zoneHelp.${c.zone}`)}</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Fitness & fatigue / form charts (crosshair synced via group 'progress-fitness')
// ---------------------------------------------------------------------------

const GROUP = 'progress-fitness';

function dayTable(data: ProgressFitnessResponse, fmt: Formatter, t: TFunction) {
  return {
    columns: [
      { key: 'day', label: t('progress.common.date') },
      { key: 'load', label: t('progress.fitness.legend.load'), numeric: true },
      { key: 'ctl', label: t('progress.fitness.legend.fitness'), numeric: true },
      { key: 'atl', label: t('progress.fitness.legend.fatigue'), numeric: true },
      { key: 'tsb', label: t('progress.fitness.legend.form'), numeric: true },
    ],
    rows: [...data.days].reverse().map((d) => ({
      day: fmt.day(d.day, 'day'),
      load: fmt.int(d.load),
      ctl: fmt.num(d.ctl, 1),
      atl: fmt.num(d.atl, 1),
      tsb: fmt.signed(d.tsb, 1),
    })),
  };
}

function loadOption(data: ProgressFitnessResponse, o: { theme: ChartTheme; fmt: Formatter; t: TFunction }): EChartsOption {
  const { theme, fmt, t } = o;
  const xs = data.days.map((d) => dayMs(d.day));
  const names = { ctl: t('progress.fitness.legend.fitness'), atl: t('progress.fitness.legend.fatigue') };
  const span = data.days.length;
  return {
    useUTC: true,
    grid: grid({ top: 40 }),
    legend: chartLegend(theme, 'line', { data: [names.ctl, names.atl] }),
    xAxis: timeAxis(theme, { axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: timeAxisLabel(fmt, span) } }),
    yAxis: valueAxis(theme, { min: 0 }),
    tooltip: axisTooltip(theme, (params: unknown) => {
      const i = (params as { dataIndex: number }[])[0]?.dataIndex ?? 0;
      const d = data.days[i]!;
      return tooltipHtml(
        fmt.day(d.day, 'weekdayShort'),
        [
          { color: theme.series[0]!, label: names.ctl, value: fmt.num(d.ctl, 1) },
          { color: theme.series[1]!, label: names.atl, value: fmt.num(d.atl, 1) },
          { color: 'transparent', label: t('progress.fitness.legend.form'), value: fmt.signed(d.tsb, 1) },
          { color: 'transparent', label: t('progress.fitness.legend.load'), value: fmt.int(d.load) },
        ],
        theme,
      );
    }),
    series: [
      areaSeries(theme, names.ctl, data.days.map((d, i) => [xs[i]!, d.ctl]), theme.series[0]!, { z: 3 }),
      lineSeries(theme, names.atl, data.days.map((d, i) => [xs[i]!, d.atl]), theme.series[1]!, { lineStyle: { width: 1.5, color: theme.series[1]! } }),
    ],
  } as EChartsOption;
}

/** Background bands for the form zones, clipped to the visible y range. */
function formOption(data: ProgressFitnessResponse, o: { theme: ChartTheme; fmt: Formatter; t: TFunction }): EChartsOption {
  const { theme, fmt, t } = o;
  const xs = data.days.map((d) => dayMs(d.day));
  const tsb = data.days.map((d) => d.tsb);
  const lo = Math.min(-40, Math.floor((Math.min(...tsb) - 5) / 10) * 10);
  const hi = Math.max(30, Math.ceil((Math.max(...tsb) + 5) / 10) * 10);
  const fills: Record<ProgressFormZone, string> = {
    transition: theme.diverging.neg,
    fresh: theme.diverging.neg,
    optimal: theme.diverging.mid,
    tired: theme.diverging.pos,
    overreaching: theme.diverging.pos,
  };
  const opacity: Record<ProgressFormZone, number> = { transition: 0.2, fresh: 0.09, optimal: 0.45, tired: 0.09, overreaching: 0.2 };
  const bands = data.zones.map((z) => [
    {
      yAxis: z.max ?? hi,
      name: t(`progress.fitness.zones.${z.key}`),
      itemStyle: { color: fills[z.key], opacity: opacity[z.key] },
    },
    { yAxis: z.min ?? lo },
  ]);
  return {
    useUTC: true,
    grid: grid({ top: 12, right: 96 }),
    xAxis: timeAxis(theme, { axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: timeAxisLabel(fmt, data.days.length) } }),
    yAxis: valueAxis(theme, { min: lo, max: hi, interval: 10, axisLabel: { color: theme.muted, fontSize: 11, formatter: (n: number) => fmt.signed(n) } }),
    tooltip: axisTooltip(theme, (params: unknown) => {
      const i = (params as { dataIndex: number }[])[0]?.dataIndex ?? 0;
      const d = data.days[i]!;
      const zone = data.zones.find((z) => (z.min === null || d.tsb >= z.min) && (z.max === null || d.tsb < z.max))!.key;
      return tooltipHtml(
        fmt.day(d.day, 'weekdayShort'),
        [{ color: theme.fg2, label: t(`progress.fitness.zones.${zone}`), value: fmt.signed(d.tsb, 1) }],
        theme,
      );
    }),
    series: [
      lineSeries(theme, t('progress.fitness.legend.form'), data.days.map((d, i) => [xs[i]!, d.tsb]), theme.fg2, {
        z: 5,
        markArea: {
          silent: true,
          label: { show: true, position: 'right', color: theme.muted, fontSize: 11, distance: 8 },
          data: bands as never,
        },
      }),
    ],
  } as EChartsOption;
}

export function LoadCharts({ data, loading }: { data: ProgressFitnessResponse; loading: boolean }) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const load = useMemo(() => loadOption(data, { theme, fmt, t }), [data, theme, fmt, t]);
  const form = useMemo(() => formOption(data, { theme, fmt, t }), [data, theme, fmt, t]);
  const table = useMemo(() => dayTable(data, fmt, t), [data, fmt, t]);
  return (
    <>
      <ChartCard
        title={t('progress.fitness.charts.load')}
        subtitle={t('progress.fitness.charts.loadSubtitle', { ctl: data.constants.ctlDays, atl: data.constants.atlDays })}
        icon={TrendingUp}
        table={table}
      >
        <EChart option={load} height={260} loading={loading} group={GROUP} ariaLabel={t('progress.fitness.charts.load')} />
      </ChartCard>
      <ChartCard title={t('progress.fitness.charts.form')} subtitle={t('progress.fitness.charts.formSubtitle')} icon={Gauge} table={table}>
        <EChart option={form} height={240} loading={loading} group={GROUP} ariaLabel={t('progress.fitness.charts.form')} />
      </ChartCard>
    </>
  );
}

// ---------------------------------------------------------------------------
// Weekly load, load ratio, ramp rate
// ---------------------------------------------------------------------------

export function WeeklyLoadCard({ data, loading }: { data: ProgressFitnessResponse; loading: boolean }) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const option = useMemo<EChartsOption>(
    () =>
      ({
        grid: grid({ right: 20 }),
        xAxis: categoryAxis(theme, data.weeks.map((w) => bucketLabel(fmt, w.key))),
        yAxis: valueAxis(theme),
        tooltip: itemTooltip(theme, (p: unknown) => {
          const w = data.weeks[(p as { dataIndex: number }).dataIndex]!;
          return tooltipHtml(
            `${fmt.day(w.fromDay, 'dayShort')} – ${fmt.day(w.toDay, 'day')}`,
            [
              { color: theme.series[0]!, label: t('progress.fitness.legend.load'), value: fmt.int(w.load) },
              { color: 'transparent', label: t('progress.common.activities'), value: fmt.int(w.count) },
            ],
            theme,
          );
        }),
        series: [barSeries(theme, t('progress.fitness.legend.load'), data.weeks.map((w) => Math.round(w.load)), theme.series[0]!)],
      }) as EChartsOption,
    [data, theme, fmt, t],
  );
  const table = useMemo(
    () => ({
      columns: [
        { key: 'week', label: t('progress.buckets.week') },
        { key: 'load', label: t('progress.fitness.legend.load'), numeric: true },
        { key: 'count', label: t('progress.common.activities'), numeric: true },
      ],
      rows: [...data.weeks].reverse().map((w) => ({
        week: `${fmt.day(w.fromDay, 'dayShort')} – ${fmt.day(w.toDay, 'day')}`,
        load: fmt.int(w.load),
        count: fmt.int(w.count),
      })),
    }),
    [data, fmt, t],
  );
  return (
    <ChartCard title={t('progress.fitness.charts.weekly')} subtitle={t('progress.fitness.charts.weeklySubtitle')} icon={Activity} table={table}>
      <EChart option={option} height={200} loading={loading} ariaLabel={t('progress.fitness.charts.weekly')} />
    </ChartCard>
  );
}

export function AcwrCard({ data, loading }: { data: ProgressFitnessResponse; loading: boolean }) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const th = data.thresholds;
  const option = useMemo<EChartsOption>(() => {
    const xs = data.days.map((d) => dayMs(d.day));
    const max = Math.max(2, ...data.days.map((d) => d.acwr ?? 0));
    return {
      useUTC: true,
      grid: grid({ right: 84 }),
      xAxis: timeAxis(theme, { axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: timeAxisLabel(fmt, data.days.length) } }),
      yAxis: valueAxis(theme, { min: 0, max: Math.ceil(max * 2) / 2, axisLabel: { color: theme.muted, fontSize: 11, formatter: (n: number) => fmt.num(n, 1) } }),
      tooltip: axisTooltip(theme, (params: unknown) => {
        const d = data.days[(params as { dataIndex: number }[])[0]?.dataIndex ?? 0]!;
        return tooltipHtml(fmt.day(d.day, 'weekdayShort'), [{ color: theme.fg2, label: t('progress.fitness.legend.acwr'), value: d.acwr === null ? '–' : fmt.num(d.acwr, 2) }], theme);
      }),
      series: [
        lineSeries(theme, t('progress.fitness.legend.acwr'), data.days.map((d, i) => [xs[i]!, d.acwr]), theme.fg2, {
          connectNulls: false,
          markArea: {
            silent: true,
            label: { show: true, position: 'right', color: theme.muted, fontSize: 11, distance: 6 },
            data: [
              [{ yAxis: th.acwrHigh, name: t('progress.fitness.sweetSpot'), itemStyle: { color: theme.diverging.mid, opacity: 0.5 } }, { yAxis: th.acwrLow }],
              [{ yAxis: Math.ceil(max * 2) / 2, name: t('progress.fitness.highRisk'), itemStyle: { color: theme.diverging.pos, opacity: 0.12 } }, { yAxis: th.acwrDanger }],
            ] as never,
          },
        }),
      ],
    } as EChartsOption;
  }, [data, theme, fmt, t, th]);
  return (
    <ChartCard
      title={t('progress.fitness.charts.acwr')}
      subtitle={t('progress.fitness.charts.acwrSubtitle', { low: fmt.num(th.acwrLow, 1), high: fmt.num(th.acwrHigh, 1) })}
      icon={Waves}
      table={dayTableAcwr(data, fmt, t)}
    >
      <EChart option={option} height={200} loading={loading} ariaLabel={t('progress.fitness.charts.acwr')} />
    </ChartCard>
  );
}

function dayTableAcwr(data: ProgressFitnessResponse, fmt: Formatter, t: TFunction) {
  return {
    columns: [
      { key: 'day', label: t('progress.common.date') },
      { key: 'acwr', label: t('progress.fitness.legend.acwr'), numeric: true },
      { key: 'ramp', label: t('progress.fitness.legend.ramp'), numeric: true },
    ],
    rows: [...data.days].reverse().map((d) => ({
      day: fmt.day(d.day, 'day'),
      acwr: d.acwr === null ? '–' : fmt.num(d.acwr, 2),
      ramp: signed1(fmt, d.ramp),
    })),
  };
}

export function RampCard({ data, loading }: { data: ProgressFitnessResponse; loading: boolean }) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const th = data.thresholds;
  const option = useMemo<EChartsOption>(() => {
    const xs = data.days.map((d) => dayMs(d.day));
    const ramps = data.days.map((d) => d.ramp);
    const top = Math.max(Math.ceil((th.rampHigh + 2) / 5) * 5, Math.ceil((Math.max(...ramps) + 1) / 5) * 5);
    const bottom = Math.min(-5, Math.floor((Math.min(...ramps) - 1) / 5) * 5);
    return {
      useUTC: true,
      grid: grid({ right: 84 }),
      xAxis: timeAxis(theme, { axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: timeAxisLabel(fmt, data.days.length) } }),
      yAxis: valueAxis(theme, { min: bottom, max: top, interval: 5, axisLabel: { color: theme.muted, fontSize: 11, formatter: (n: number) => fmt.signed(n) } }),
      tooltip: axisTooltip(theme, (params: unknown) => {
        const d = data.days[(params as { dataIndex: number }[])[0]?.dataIndex ?? 0]!;
        return tooltipHtml(fmt.day(d.day, 'weekdayShort'), [{ color: theme.fg2, label: t('progress.fitness.legend.ramp'), value: t('progress.units.perWeek', { value: signed1(fmt, d.ramp) }) }], theme);
      }),
      series: [
        lineSeries(theme, t('progress.fitness.legend.ramp'), data.days.map((d, i) => [xs[i]!, d.ramp]), theme.fg2, {
          markArea: {
            silent: true,
            label: { show: true, position: 'right', color: theme.muted, fontSize: 11, distance: 6 },
            data: [
              [{ yAxis: th.rampHigh, name: t('progress.fitness.ramp.elevated'), itemStyle: { color: theme.diverging.pos, opacity: 0.08 } }, { yAxis: th.rampElevated }],
              [{ yAxis: top, name: t('progress.fitness.ramp.high'), itemStyle: { color: theme.diverging.pos, opacity: 0.18 } }, { yAxis: th.rampHigh }],
            ] as never,
          },
        }),
      ],
    } as EChartsOption;
  }, [data, theme, fmt, t, th]);
  return (
    <ChartCard title={t('progress.fitness.charts.ramp')} subtitle={t('progress.fitness.charts.rampSubtitle')} icon={TrendingUp} table={dayTableAcwr(data, fmt, t)}>
      <EChart option={option} height={200} loading={loading} ariaLabel={t('progress.fitness.charts.ramp')} />
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
// VO2max with fitness levels
// ---------------------------------------------------------------------------

export function Vo2Card({ data, loading, error }: { data: ProgressPhysiology | undefined; loading: boolean; error: unknown }) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const v = data?.vo2max;
  const names = useMemo(() => ({ readings: t('progress.fitness.legend.readings'), median: t('progress.fitness.legend.median30') }), [t]);
  const option = useMemo<EChartsOption | null>(() => {
    if (!v || !v.points.length) return null;
    const xs = v.points.map((p) => dayMs(p.day));
    const values = v.points.map((p) => p.value);
    const lo = Math.floor(Math.min(...values) - 2);
    const hi = Math.ceil(Math.max(...values) + 2);
    const ramp = theme.seqBlue;
    const bands = (v.levels ?? [])
      .filter((l) => (l.max ?? Infinity) > lo && (l.min ?? -Infinity) < hi)
      .map((l) => {
        const i = (['poor', 'fair', 'good', 'excellent', 'superior'] as ProgressVo2Level[]).indexOf(l.key);
        return [
          { yAxis: Math.min(hi, l.max ?? hi), name: t(`progress.fitness.levels.${l.key}`), itemStyle: { color: ramp[i]!, opacity: 0.14 } },
          { yAxis: Math.max(lo, l.min ?? lo) },
        ];
      });
    return {
      useUTC: true,
      grid: grid({ top: 40, right: v.levels ? 92 : 16 }),
      legend: chartLegend(theme, 'line', {
        data: [{ name: names.readings, icon: 'circle', itemStyle: { color: theme.muted, borderWidth: 0 } }, { name: names.median }],
      }),
      xAxis: timeAxis(theme, { axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: timeAxisLabel(fmt, (xs.at(-1)! - xs[0]!) / 86_400_000) } }),
      yAxis: valueAxis(theme, { min: lo, max: hi, axisLabel: { color: theme.muted, fontSize: 11, formatter: (n: number) => fmt.num(n) } }),
      tooltip: axisTooltip(theme, (params: unknown) => {
        const ps = params as { dataIndex: number; seriesIndex: number; axisValue: number }[];
        const i = ps[0]?.dataIndex ?? 0;
        const rows = [{ color: theme.muted, label: names.readings, value: fmt.num(v.points[i]!.value, 1) }];
        const m = v.median[i];
        if (m !== null && m !== undefined) rows.push({ color: theme.series[0]!, label: names.median, value: fmt.num(m, 1) });
        return tooltipHtml(fmt.day(v.points[i]!.day, 'day'), rows, theme);
      }),
      series: [
        scatterSeries(theme, names.readings, v.points.map((p, i) => [xs[i]!, p.value]), theme.muted, {
          symbolSize: 6,
          itemStyle: { color: theme.muted, opacity: 0.7, borderWidth: 0 },
          markArea: bands.length
            ? { silent: true, label: { show: true, position: 'right', color: theme.muted, fontSize: 11, distance: 8 }, data: bands as never }
            : undefined,
        }),
        lineSeries(theme, names.median, v.median.map((m, i) => [xs[i]!, m]), theme.series[0]!, { z: 4 }),
      ],
    } as EChartsOption;
  }, [v, theme, fmt, t, names]);
  const table = useMemo(
    () =>
      v
        ? {
            columns: [
              { key: 'day', label: t('progress.common.date') },
              { key: 'value', label: t('progress.fitness.charts.vo2max'), numeric: true },
              { key: 'median', label: names.median, numeric: true },
            ],
            rows: [...v.points].reverse().map((p, k) => {
              const m = v.median[v.points.length - 1 - k];
              return { day: fmt.day(p.day, 'day'), value: fmt.num(p.value, 1), median: m == null ? '–' : fmt.num(m, 1) };
            }),
          }
        : undefined,
    [v, fmt, t, names],
  );
  const footer = v
    ? v.levels && v.age !== null
      ? t('progress.fitness.levelNote', { sex: t(`progress.fitness.sexes.${v.sex ?? 'other'}`), age: v.age })
      : t('progress.fitness.noAge')
    : undefined;
  return (
    <ChartCard
      title={t('progress.fitness.charts.vo2max')}
      subtitle={t('progress.fitness.charts.vo2maxSubtitle')}
      icon={Gauge}
      table={option ? table : undefined}
      footer={footer}
      actions={
        v?.latest ? (
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-fg">{fmt.num(v.latest.value, 1)}</span>
            {v.level && <Badge tone="accent">{t(`progress.fitness.levels.${v.level}`)}</Badge>}
          </span>
        ) : undefined
      }
    >
      {error ? (
        <ErrorState error={error} />
      ) : !v ? (
        <ChartSkeleton height={300} />
      ) : !option ? (
        <EmptyState icon={Gauge} title={t('progress.fitness.noVo2')} className="h-[300px]" />
      ) : (
        <EChart option={option} height={300} loading={loading} ariaLabel={t('progress.fitness.charts.vo2max')} />
      )}
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
// Resting heart rate / HRV context
// ---------------------------------------------------------------------------

export function DailyContextCard({
  kind,
  series,
  loading,
  error,
}: {
  kind: 'restingHr' | 'hrv';
  series: ProgressDailySeries | undefined;
  loading: boolean;
  /** The request failed: say so instead of a skeleton that never ends. */
  error: unknown;
}) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const unit = kind === 'restingHr' ? 'bpm' : 'ms';
  const color = theme.series[kind === 'restingHr' ? 0 : 2]!;
  const names = useMemo(() => ({ daily: t('progress.fitness.legend.daily'), avg: t('progress.fitness.legend.avg7') }), [t]);
  const option = useMemo<EChartsOption | null>(() => {
    if (!series || !series.points.length) return null;
    const xs = series.points.map((p) => dayMs(p.day));
    return {
      useUTC: true,
      grid: grid({ top: 36 }),
      legend: chartLegend(theme, 'line', { data: [names.daily, names.avg] }),
      xAxis: timeAxis(theme, { axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: timeAxisLabel(fmt, (xs.at(-1)! - xs[0]!) / 86_400_000) } }),
      yAxis: valueAxis(theme, { scale: true, splitNumber: 3 }),
      tooltip: axisTooltip(theme, (params: unknown) => {
        const i = (params as { dataIndex: number }[])[0]?.dataIndex ?? 0;
        const rows = [{ color: theme.axis, label: names.daily, value: `${fmt.num(series.points[i]!.value, 0)} ${unit}` }];
        const a = series.avg7[i];
        if (a !== null && a !== undefined) rows.push({ color, label: names.avg, value: `${fmt.num(a, 1)} ${unit}` });
        return tooltipHtml(fmt.day(series.points[i]!.day, 'weekdayShort'), rows, theme);
      }),
      series: [
        lineSeries(theme, names.daily, series.points.map((p, i) => [xs[i]!, p.value]), theme.axis, { lineStyle: { width: 1, color: theme.axis } }),
        lineSeries(theme, names.avg, series.avg7.map((a, i) => [xs[i]!, a]), color),
      ],
    } as EChartsOption;
  }, [series, theme, fmt, names, unit, color]);
  const table = useMemo(
    () =>
      series
        ? {
            columns: [
              { key: 'day', label: t('progress.common.date') },
              { key: 'value', label: names.daily, numeric: true },
              { key: 'avg', label: names.avg, numeric: true },
            ],
            rows: [...series.points].reverse().map((p, k) => {
              const a = series.avg7[series.points.length - 1 - k];
              return { day: fmt.day(p.day, 'day'), value: `${fmt.num(p.value, 0)} ${unit}`, avg: a == null ? '–' : `${fmt.num(a, 1)} ${unit}` };
            }),
          }
        : undefined,
    [series, fmt, t, names, unit],
  );
  const title = t(kind === 'restingHr' ? 'progress.fitness.charts.restingHr' : 'progress.fitness.charts.hrv');
  return (
    <ChartCard
      title={title}
      subtitle={t(kind === 'restingHr' ? 'progress.fitness.charts.restingHrSubtitle' : 'progress.fitness.charts.hrvSubtitle')}
      icon={HeartPulse}
      table={option ? table : undefined}
      actions={
        series?.latest ? (
          <span className="text-sm font-semibold text-fg">
            {fmt.num(series.latest.value, 0)} <span className="text-xs font-medium text-fg-3">{unit}</span>
          </span>
        ) : undefined
      }
    >
      {error ? (
        <ErrorState error={error} />
      ) : !series ? (
        <ChartSkeleton height={170} />
      ) : !option ? (
        <EmptyState title={t('progress.fitness.noSeries')} className="h-[170px]" />
      ) : (
        <EChart option={option} height={170} loading={loading} ariaLabel={title} />
      )}
    </ChartCard>
  );
}
