import { useMemo } from 'react';
import { BarChart3 } from 'lucide-react';
import type { BarSeriesOption } from 'echarts';
import type { MetricAgg, MetricPoint, MetricSeries, SleepStage } from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { axisTooltip, barSeries, categoryAxis, grid, legend, stackedBarSeries, tooltipHtml, valueAxis } from '@/components/charts/options';
import { useChartTheme } from '@/components/charts/theme';
import { Skeleton } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { stageColor } from '../../lib/sleep';
import { identifierColor } from '../../lib/colors';
import { useMetricFormat } from '../../lib/metrics';
import { TrendChart } from '../TrendChart';

export type MetricMode = 'average' | 'total';

const SLEEP = 'HKCategoryTypeIdentifierSleepAnalysis';
/** Stack order of sleep values (bottom → top); InBed overlaps the stages and is never stacked. */
const SLEEP_ORDER = ['AsleepDeep', 'AsleepCore', 'AsleepREM', 'Asleep', 'AsleepUnspecified', 'Awake'];
const SLEEP_STAGE: Record<string, SleepStage> = {
  AsleepDeep: 'deep',
  AsleepCore: 'core',
  AsleepREM: 'rem',
  Asleep: 'asleep',
  AsleepUnspecified: 'asleep',
  Awake: 'awake',
};
const MAX_STACK = 7;

/** Period label for axes (short) and tooltips (long). */
export function usePeriodLabel(agg: MetricAgg) {
  const fmt = useFormat();
  const t = useT();
  return (key: string, long: boolean): string => {
    if (agg === 'month') return fmt.day(key, long ? 'month' : 'monthYearShort');
    if (agg === 'week') return long ? t('health.common.weekOf', { date: fmt.day(key, 'dayShort') }) : fmt.day(key, 'dayShort');
    return fmt.day(key, long ? 'weekday' : 'dayShort');
  };
}

interface Props {
  series: MetricSeries;
  mode: MetricMode;
  loading?: boolean;
}

/** value of a point under the chosen mode (daily average of the period instead of its total) */
const shownValue = (p: MetricPoint, agg: MetricAgg, mode: MetricMode): number =>
  mode === 'average' && agg !== 'day' && p.days > 0 ? p.value / p.days : p.value;

/**
 * The chart of the metric page, chosen by the kind of data: cumulative measures as bars, discrete measures as a line with a
 * min–max band, category types (sleep stages, stand hours, symptoms …) as stacked bars per value.
 */
export function MetricChart({ series, mode, loading }: Props) {
  const t = useT();
  const fmt = useFormat();
  const m = useMetricFormat();
  const theme = useChartTheme();
  const { type, agg } = series;
  const identifier = type.identifier;
  const color = identifierColor(theme, identifier);
  const label = usePeriodLabel(agg);
  const noData = t('health.common.noDataRange');
  const unitLabel = m.unitLabel(identifier, type.unit);

  const isEvent = type.kind === 'category' && series.categories.length > 0 && series.categories.every((c) => c.total === 0);
  const isCategory = type.aggregation === 'duration';
  const isSum = type.aggregation === 'sum';

  const titleKey = isCategory
    ? 'health.metric.chart.title'
    : isSum
      ? agg === 'day'
        ? 'health.metric.chart.sumDay'
        : mode === 'total'
          ? agg === 'week'
            ? 'health.metric.chart.sumWeek'
            : 'health.metric.chart.sumMonth'
          : agg === 'week'
            ? 'health.metric.chart.avgWeek'
            : 'health.metric.chart.avgMonth'
      : 'health.metric.chart.title';

  const model = useMemo(() => {
    if (type.aggregation === 'avg') return null;
    const keys = series.points.map((p) => p.key);
    const labels = keys.map((k) => label(k, false));
    const spec = m.spec(identifier, type.unit);

    // ---- category types: stacked per value ----------------------------------------------------------------
    if (isCategory) {
      let cats = series.categories.filter((c) => !(identifier === SLEEP && c.value === 'InBed'));
      if (identifier === SLEEP) {
        cats = [...cats].sort((a, b) => SLEEP_ORDER.indexOf(a.value) - SLEEP_ORDER.indexOf(b.value));
        cats = cats.filter((c) => SLEEP_ORDER.includes(c.value));
      }
      // fold the tail into "other" past the palette
      let folded = cats;
      let other: typeof cats[number] | null = null;
      if (identifier !== SLEEP && cats.length > MAX_STACK) {
        folded = cats.slice(0, MAX_STACK);
        const rest = cats.slice(MAX_STACK);
        const byKey = new Map<string, MetricPoint>();
        for (const c of rest)
          for (const p of c.points) {
            const prev = byKey.get(p.key);
            byKey.set(p.key, prev ? { ...prev, value: prev.value + p.value, n: prev.n + p.n } : { ...p });
          }
        other = { value: '__other', total: rest.reduce((s, c) => s + c.total, 0), points: [...byKey.values()] };
      }
      const all = other ? [...folded, other] : folded;
      const byValue = all.map((c) => ({ c, byKey: new Map(c.points.map((p) => [p.key, p])) }));
      const valueOf = (c: { byKey: Map<string, MetricPoint> }, key: string): number => {
        const p = c.byKey.get(key);
        if (!p) return 0;
        const pt = isEvent ? { ...p, value: p.n } : p;
        return shownValue(pt, agg, mode);
      };
      const stackTotals = keys.map((k) => byValue.reduce((s, c) => s + valueOf(c, k), 0));
      const maxStack = Math.max(0, ...stackTotals);
      // minutes → hours once a bar exceeds three hours
      const hours = !isEvent && maxStack >= 180;
      const div = hours ? 60 : 1;
      const slotNames = all.map((c) => (c.value === '__other' ? t('health.metric.chart.other') : isEvent ? t('health.metric.chart.events') : m.categoryLabel(c.value)));
      return {
        kind: 'category' as const,
        keys,
        labels,
        names: slotNames,
        colors: byValue.map(({ c }, i) =>
          c.value === '__other'
            ? theme.other
            : identifier === SLEEP && SLEEP_STAGE[c.value]
              ? stageColor(theme, SLEEP_STAGE[c.value]!)
              : theme.series[i % 8]!,
        ),
        values: byValue.map((c) => keys.map((k) => valueOf(c, k) / div)),
        raw: byValue.map((c) => keys.map((k) => valueOf(c, k))),
        hours,
        axisUnit: isEvent ? '' : hours ? 'h' : 'min',
        isEvent,
        spec,
      };
    }

    // ---- cumulative measures: bars -------------------------------------------------------------------------
    const raw = series.points.map((p) => shownValue(p, agg, mode));
    if (spec.duration) {
      const mins = raw.map((v) => (spec.duration === 'minutes' ? v : v / 60));
      const hours = Math.max(0, ...mins) >= 180;
      return {
        kind: 'sum' as const,
        keys,
        labels,
        raw,
        values: mins.map((v) => (hours ? v / 60 : v)),
        axisUnit: hours ? 'h' : 'min',
        spec,
      };
    }
    return { kind: 'sum' as const, keys, labels, raw, values: raw.map((v) => spec.convert(v)), axisUnit: spec.unit, spec };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, mode, theme, fmt, m.units, isEvent]);

  // line + band for discrete measures
  if (type.aggregation === 'avg') {
    return (
      <TrendChart
        title={`${t(titleKey)}${unitLabel ? ` (${unitLabel})` : ''}`}
        subtitle={t('health.metric.chart.subtitleAvg')}
        icon={BarChart3}
        metric={identifier}
        unit={type.unit}
        points={series.points.map((p) => ({ day: p.key, value: p.value, min: p.min, max: p.max }))}
        color={color}
        band
        agg={agg}
        loading={loading}
        emptyText={noData}
        height={280}
      />
    );
  }

  const chart = model!;
  const dimmed = loading;

  const option = (() => {
    if (chart.kind === 'category') {
      const series2: BarSeriesOption[] = stackedBarSeries(
        theme,
        'stack',
        chart.names.map((name, i) => ({ name, data: chart.values[i]!, color: chart.colors[i]! })),
      );
      const multi = chart.names.length >= 2;
      return {
        grid: grid({ top: multi ? 34 : 12 }),
        legend: multi ? legend(theme, 'rect', { data: chart.names }) : { show: false },
        tooltip: axisTooltip(
          theme,
          (params) => {
            const p = (params as { dataIndex: number }[])[0];
            const i = p?.dataIndex ?? -1;
            if (i < 0) return '';
            const rows = chart.names
              .map((name, k) => ({
                color: chart.colors[k]!,
                label: name,
                value: chart.isEvent ? fmt.int(chart.raw[k]![i]!) : m.value(identifier, chart.raw[k]![i]!, type.unit),
                v: chart.raw[k]![i]!,
              }))
              .filter((r) => r.v > 0)
              .reverse();
            return tooltipHtml(label(chart.keys[i]!, true), rows, theme);
          },
          { axisPointer: { type: 'shadow', shadowStyle: { color: theme.grid, opacity: 0.35 } } },
        ),
        xAxis: categoryAxis(theme, chart.labels, { axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true } }),
        yAxis: valueAxis(theme, { axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => fmt.num(v, chart.hours ? 1 : 0) } }),
        series: series2,
      };
    }
    const s = barSeries(theme, t(titleKey), chart.values, color, { barMaxWidth: 24 });
    return {
      grid: grid({ top: 12 }),
      tooltip: axisTooltip(
        theme,
        (params) => {
          const p = (params as { dataIndex: number }[])[0];
          const i = p?.dataIndex ?? -1;
          const pt = series.points[i];
          if (!pt) return '';
          const rows = [{ color, label: t(titleKey), value: m.value(identifier, chart.raw[i]!, type.unit) }];
          const head = agg === 'day' ? label(pt.key, true) : `${label(pt.key, true)} · ${t('health.metric.chart.days', { count: pt.days })}`;
          return tooltipHtml(head, rows, theme);
        },
        { axisPointer: { type: 'shadow', shadowStyle: { color: theme.grid, opacity: 0.35 } } },
      ),
      xAxis: categoryAxis(theme, chart.labels, { axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true } }),
      yAxis: valueAxis(theme, {
        axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => fmt.num(v, chart.axisUnit === 'h' ? 1 : 0) },
      }),
      series: [s],
    };
  })();

  const columns =
    chart.kind === 'category'
      ? [{ key: 'period', label: t('health.common.date') }, ...chart.names.map((n, i) => ({ key: `c${i}`, label: n, numeric: true }))]
      : [
          { key: 'period', label: t('health.common.date') },
          { key: 'value', label: unitLabel ? `${t(titleKey)} (${unitLabel})` : t(titleKey), numeric: true },
          { key: 'days', label: t('health.common.days'), numeric: true },
        ];
  const rows =
    chart.kind === 'category'
      ? [...chart.keys].reverse().map((k) => {
          const i = chart.keys.indexOf(k);
          return {
            period: label(k, false),
            ...Object.fromEntries(
              chart.names.map((_, c) => [`c${c}`, chart.isEvent ? fmt.int(chart.raw[c]![i]!) : m.plain(identifier, chart.raw[c]![i]!, type.unit)]),
            ),
          };
        })
      : [...series.points].reverse().map((p) => {
          const i = series.points.indexOf(p);
          return { period: label(p.key, false), value: m.plain(identifier, chart.raw[i]!, type.unit), days: fmt.int(p.days) };
        });

  const hasData = series.points.length > 0;
  return (
    <ChartCard
      title={`${t(titleKey)}${chart.axisUnit && !(chart.kind === 'category' && chart.isEvent) ? ` (${chart.axisUnit})` : ''}`}
      subtitle={t(isCategory ? 'health.metric.chart.subtitleCat' : mode === 'average' && agg !== 'day' ? 'health.metric.chart.subtitleSumAvg' : 'health.metric.chart.subtitleSum')}
      icon={BarChart3}
      table={hasData ? { columns, rows } : undefined}
      footer={
        hasData && (isSum || isCategory) && mode === 'average' && agg !== 'day' ? <span>{t('health.metric.chart.perDayHint')}</span> : undefined
      }
    >
      {loading && !hasData ? (
        <div style={{ height: 280 }}>
          <Skeleton className="h-full w-full" />
        </div>
      ) : !hasData ? (
        <p className="py-12 text-center text-sm text-fg-3">{noData}</p>
      ) : (
        <EChart option={option} height={280} loading={dimmed} ariaLabel={t(titleKey)} />
      )}
    </ChartCard>
  );
}

