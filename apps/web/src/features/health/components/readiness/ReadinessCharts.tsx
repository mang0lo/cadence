import { useMemo } from 'react';
import type { EChartsOption, LineSeriesOption } from 'echarts';
import { Activity, BatteryCharging, HeartPulse } from 'lucide-react';
import type { ReadinessBand, ReadinessModelInfo, ReadinessRange, ReadinessTrendDay } from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { axisTooltip, grid, legend, lineSeries, timeAxis, tooltipHtml, valueAxis } from '@/components/charts/options';
import { useChartTheme, type ChartTheme } from '@/components/charts/theme';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { LEGEND_LINE_ICON, dayAxisLabel } from '../../lib/chart';
import { measureColor } from '../../lib/colors';
import { useMetricFormat } from '../../lib/metrics';

const HRV = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN';
const RHR = 'HKQuantityTypeIdentifierRestingHeartRate';

const xAxis = (theme: ChartTheme, fmt: ReturnType<typeof useFormat>) =>
  timeAxis(theme, { axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: dayAxisLabel(fmt) } });

function Empty({ text, height }: { text: string; height: number }) {
  return (
    <p className="grid place-items-center text-center text-sm text-fg-3" style={{ height }}>
      {text}
    </p>
  );
}

/** Daily score as a neutral line over the bands (status washes with their names at the right). */
export function ReadinessTrendChart({ history, model, loading }: { history: ReadinessTrendDay[]; model: ReadinessModelInfo; loading?: boolean }) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const total = Object.keys(model.weights).length;
  const title = t('health.readiness.charts.trend.title');
  const hasScore = history.some((h) => h.score !== null);

  const option = useMemo<EChartsOption>(() => {
    const band = (b: ReadinessBand) => t(`health.readiness.bands.${b}`);
    const fill: Record<ReadinessBand, { color: string; opacity: number }> = {
      ready: { color: theme.status.good, opacity: 0.1 },
      normal: { color: theme.surface, opacity: 0 },
      easy: { color: theme.status.warning, opacity: 0.16 },
      recover: { color: theme.status.critical, opacity: 0.12 },
    };
    const areas = model.bands.map((b, i) => [
      { yAxis: i === 0 ? 100 : model.bands[i - 1]!.min, name: band(b.key), itemStyle: fill[b.key] },
      { yAxis: b.min },
    ]);
    return {
      grid: grid({ top: 12, right: 108 }),
      xAxis: xAxis(theme, fmt),
      yAxis: valueAxis(theme, { min: 0, max: 100, interval: 20, axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => fmt.int(v) } }),
      tooltip: axisTooltip(theme, (params) => {
        const h = history[(params as { dataIndex: number }[])[0]?.dataIndex ?? -1];
        if (!h) return '';
        return tooltipHtml(
          fmt.day(h.day, 'weekday'),
          [
            {
              color: theme.fg2,
              label: h.band ? band(h.band) : t('health.readiness.charts.noScore'),
              value: h.score === null ? '–' : fmt.int(h.score),
            },
            {
              color: 'transparent',
              label: t('health.readiness.charts.signals'),
              value: t('health.readiness.charts.signalsValue', { used: h.used, total }),
            },
          ],
          theme,
        );
      }),
      series: [
        lineSeries(theme, t('health.readiness.charts.score'), history.map((h) => [h.day, h.score]), theme.fg2, {
          showSymbol: history.length <= 45,
          symbolSize: 6,
          connectNulls: false,
          z: 5,
          markArea: {
            silent: true,
            label: { show: true, position: 'right', color: theme.muted, fontSize: 11, distance: 8 },
            data: areas as never,
          },
        }),
      ],
    } as EChartsOption;
  }, [history, model.bands, theme, fmt, t, total]);

  const table = useMemo(
    () => ({
      columns: [
        { key: 'day', label: t('health.common.date') },
        { key: 'score', label: t('health.readiness.charts.score'), numeric: true },
        { key: 'band', label: t('health.readiness.charts.band') },
        { key: 'signals', label: t('health.readiness.charts.signals'), numeric: true },
      ],
      rows: [...history].reverse().map((h) => ({
        day: fmt.day(h.day, 'weekdayShort'),
        score: h.score === null ? '–' : fmt.int(h.score),
        band: h.band ? t(`health.readiness.bands.${h.band}`) : '–',
        signals: t('health.readiness.charts.signalsValue', { used: h.used, total }),
      })),
    }),
    [history, fmt, t, total],
  );

  return (
    <ChartCard title={title} subtitle={t('health.readiness.charts.trend.subtitle')} icon={BatteryCharging} table={hasScore ? table : undefined}>
      {hasScore ? (
        <EChart option={option} height={240} loading={loading} ariaLabel={title} />
      ) : (
        <Empty text={t('health.readiness.charts.empty')} height={240} />
      )}
    </ChartCard>
  );
}

/** Invisible base + visible width: the normal range as a band (stacked lines; gaps where there is no baseline). */
function rangeSeries(days: string[], ranges: (ReadinessRange | null)[], name: string, theme: ChartTheme): LineSeriesOption[] {
  const common = { type: 'line', stack: 'normal', symbol: 'none', silent: true, emphasis: { disabled: true }, tooltip: { show: false } } as const;
  return [
    { ...common, name: '__base', data: days.map((d, i) => [d, ranges[i]?.low ?? null]), lineStyle: { opacity: 0 } },
    {
      ...common,
      name,
      data: days.map((d, i) => [d, ranges[i] ? ranges[i]!.high - ranges[i]!.low : null]),
      lineStyle: { opacity: 0 },
      areaStyle: { color: theme.muted, opacity: 0.2 },
    },
  ];
}

interface BaselineProps {
  history: ReadinessTrendDay[];
  loading?: boolean;
}

/** Daily SDNN (faint), its 7-day average (the line that is scored) and the normal range of that average. */
export function HrvBaselineChart({ history, hrvDays, loading }: BaselineProps & { hrvDays: number }) {
  const t = useT();
  const fmt = useFormat();
  const m = useMetricFormat();
  const theme = useChartTheme();
  const color = measureColor(theme, 'hrv');
  const title = t('health.readiness.charts.hrv.title');
  const names = useMemo(
    () => ({
      daily: t('health.readiness.charts.daily'),
      avg: t('health.readiness.charts.avg', { days: hrvDays }),
      range: t('health.readiness.charts.normalRange'),
    }),
    [t, hrvDays],
  );
  const has = history.some((h) => h.hrv !== null || h.hrv7 !== null);
  const rangeText = (r: ReadinessRange | null) => (r ? `${m.plain(HRV, r.low)}–${m.value(HRV, r.high)}` : '–');

  const option = useMemo<EChartsOption>(() => {
    const days = history.map((h) => h.day);
    return {
      grid: grid({ top: 34 }),
      legend: legend(theme, 'line', {
        data: [
          { name: names.range, icon: 'roundRect', itemStyle: { color: theme.muted, opacity: 0.45, borderWidth: 0 } },
          { name: names.daily, itemStyle: { color, opacity: 0.5, borderWidth: 0 } },
          { name: names.avg, itemStyle: { color, borderWidth: 0 } },
        ],
        ...LEGEND_LINE_ICON,
      }),
      xAxis: xAxis(theme, fmt),
      yAxis: valueAxis(theme, { scale: true, axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => fmt.num(v, 0) } }),
      tooltip: axisTooltip(theme, (params) => {
        const h = history[(params as { dataIndex: number }[])[0]?.dataIndex ?? -1];
        if (!h) return '';
        return tooltipHtml(
          fmt.day(h.day, 'weekday'),
          [
            { color, label: names.avg, value: h.hrv7 === null ? '–' : m.value(HRV, h.hrv7) },
            { color: `color-mix(in srgb, ${color} 50%, transparent)`, label: names.daily, value: h.hrv === null ? '–' : m.value(HRV, h.hrv) },
            { color: theme.muted, label: names.range, value: rangeText(h.hrvRange) },
          ],
          theme,
        );
      }),
      series: [
        ...rangeSeries(days, history.map((h) => h.hrvRange), names.range, theme),
        lineSeries(theme, names.daily, history.map((h) => [h.day, h.hrv]), color, {
          showSymbol: history.length <= 45,
          symbolSize: 5,
          connectNulls: true,
          lineStyle: { width: 1.25, color, opacity: 0.45, cap: 'round', join: 'round' },
          itemStyle: { color, opacity: 0.55, borderColor: theme.surface, borderWidth: 1 },
        }),
        lineSeries(theme, names.avg, history.map((h) => [h.day, h.hrv7]), color, { connectNulls: false, z: 4 }),
      ],
    } as EChartsOption;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, theme, fmt, m, color, names]);

  const table = useMemo(
    () => ({
      columns: [
        { key: 'day', label: t('health.common.date') },
        { key: 'daily', label: `${names.daily} (${m.unitLabel(HRV)})`, numeric: true },
        { key: 'avg', label: `${names.avg} (${m.unitLabel(HRV)})`, numeric: true },
        { key: 'range', label: names.range, numeric: true },
      ],
      rows: [...history].reverse().map((h) => ({
        day: fmt.day(h.day, 'weekdayShort'),
        daily: h.hrv === null ? '–' : m.plain(HRV, h.hrv),
        avg: h.hrv7 === null ? '–' : m.plain(HRV, h.hrv7),
        range: rangeText(h.hrvRange),
      })),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [history, fmt, m, t, names],
  );

  return (
    <ChartCard
      title={title}
      subtitle={t('health.readiness.charts.hrv.subtitle', { days: hrvDays })}
      icon={Activity}
      table={has ? table : undefined}
    >
      {has ? <EChart option={option} height={250} loading={loading} ariaLabel={title} /> : <Empty text={t('health.readiness.charts.emptyHrv')} height={250} />}
    </ChartCard>
  );
}

/** Daily resting heart rate against its normal range. */
export function RestingHrBaselineChart({ history, loading }: BaselineProps) {
  const t = useT();
  const fmt = useFormat();
  const m = useMetricFormat();
  const theme = useChartTheme();
  const color = measureColor(theme, 'restingHr');
  const title = t('health.readiness.charts.restingHr.title');
  const names = useMemo(
    () => ({ value: t('health.readiness.factors.names.restingHr'), range: t('health.readiness.charts.normalRange') }),
    [t],
  );
  const has = history.some((h) => h.restingHr !== null);
  const rangeText = (r: ReadinessRange | null) => (r ? `${m.plain(RHR, r.low)}–${m.value(RHR, r.high)}` : '–');

  const option = useMemo<EChartsOption>(() => {
    const days = history.map((h) => h.day);
    return {
      grid: grid({ top: 34 }),
      legend: legend(theme, 'line', {
        data: [
          { name: names.range, icon: 'roundRect', itemStyle: { color: theme.muted, opacity: 0.45, borderWidth: 0 } },
          { name: names.value, itemStyle: { color, borderWidth: 0 } },
        ],
        ...LEGEND_LINE_ICON,
      }),
      xAxis: xAxis(theme, fmt),
      yAxis: valueAxis(theme, { scale: true, axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => fmt.num(v, 0) } }),
      tooltip: axisTooltip(theme, (params) => {
        const h = history[(params as { dataIndex: number }[])[0]?.dataIndex ?? -1];
        if (!h) return '';
        return tooltipHtml(
          fmt.day(h.day, 'weekday'),
          [
            { color, label: names.value, value: h.restingHr === null ? '–' : m.value(RHR, h.restingHr) },
            { color: theme.muted, label: names.range, value: rangeText(h.restingHrRange) },
          ],
          theme,
        );
      }),
      series: [
        ...rangeSeries(days, history.map((h) => h.restingHrRange), names.range, theme),
        lineSeries(theme, names.value, history.map((h) => [h.day, h.restingHr]), color, {
          showSymbol: history.length <= 45,
          symbolSize: 6,
          connectNulls: true,
          z: 4,
        }),
      ],
    } as EChartsOption;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, theme, fmt, m, color, names]);

  const table = useMemo(
    () => ({
      columns: [
        { key: 'day', label: t('health.common.date') },
        { key: 'value', label: `${names.value} (${m.unitLabel(RHR)})`, numeric: true },
        { key: 'range', label: names.range, numeric: true },
      ],
      rows: [...history].reverse().map((h) => ({
        day: fmt.day(h.day, 'weekdayShort'),
        value: h.restingHr === null ? '–' : m.plain(RHR, h.restingHr),
        range: rangeText(h.restingHrRange),
      })),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [history, fmt, m, t, names],
  );

  return (
    <ChartCard title={title} subtitle={t('health.readiness.charts.restingHr.subtitle')} icon={HeartPulse} table={has ? table : undefined}>
      {has ? <EChart option={option} height={250} loading={loading} ariaLabel={title} /> : <Empty text={t('health.readiness.charts.emptyRhr')} height={250} />}
    </ChartCard>
  );
}
