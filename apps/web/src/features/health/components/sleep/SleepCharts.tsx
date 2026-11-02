import { useMemo } from 'react';
import type { BarSeriesOption } from 'echarts';
import { BedDouble, Clock, Moon } from 'lucide-react';
import { rollingMeanByDay, type SleepNight, type SleepStage } from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import {
  axisTooltip,
  categoryAxis,
  grid,
  legend,
  lineSeries,
  barSeries,
  stackedBarSeries,
  timeAxis,
  tooltipHtml,
  valueAxis,
} from '@/components/charts/options';
import { useChartTheme } from '@/components/charts/theme';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { LEGEND_LINE_ICON, dayAxisLabel, useChartClick } from '../../lib/chart';
import {
  STAGE_STACK,
  bedOffset,
  scheduleStats,
  stageColor,
  stageSeconds,
  tracked,
  wakeOffset,
  wrapMinutes,
} from '../../lib/sleep';

/** Labels of the sleep stages in the current language. */
export function useStageLabel() {
  const t = useT();
  return (stage: SleepStage, short = false) =>
    t(`health.sleep.stage.${stage === 'asleep' && !short ? 'asleepNoStages' : stage}`);
}

interface ChartProps {
  nights: SleepNight[];
  selectedDay: string | null;
  onSelect: (day: string) => void;
}

const HOUR = 3600;

/** Stacked bars: hours per stage per night (deep at the bottom, awake time in bed on top). */
export function StagesChart({ nights, selectedDay, onSelect }: ChartProps) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const stageLabel = useStageLabel();
  const data = useMemo(() => tracked(nights), [nights]);
  const onChartClick = useChartClick((i) => {
    const n = data[i];
    if (n) onSelect(n.day);
  });
  const stages = useMemo(
    () => STAGE_STACK.filter((s) => s !== 'asleep' || data.some((n) => n.unspecS > 0)),
    [data],
  );

  const option = useMemo(() => {
    const days = data.map((n) => n.day);
    const series = stackedBarSeries(
      theme,
      'stages',
      stages.map((s) => ({
        name: stageLabel(s),
        color: stageColor(theme, s),
        data: data.map((n) => stageSeconds(n, s) / HOUR),
      })),
    );
    const sel = selectedDay ? days.indexOf(selectedDay) : -1;
    if (sel >= 0 && series[0]) {
      (series[0] as { markArea?: unknown }).markArea = {
        silent: true,
        itemStyle: { color: theme.accent, opacity: 0.1 },
        data: [[{ xAxis: selectedDay }, { xAxis: selectedDay }]],
      };
    }
    return {
      grid: grid({ top: 34 }),
      legend: legend(theme, 'rect', { data: stages.map((s) => stageLabel(s)) }),
      tooltip: axisTooltip(
        theme,
        (params) => {
          const p = (params as { dataIndex: number }[])[0];
          const n = p ? data[p.dataIndex] : undefined;
          if (!n) return '';
          const rows = [...stages]
            .reverse()
            .map((s) => ({ color: stageColor(theme, s), label: stageLabel(s), value: fmt.durationShort(stageSeconds(n, s)) }));
          return tooltipHtml(
            `${fmt.day(n.day, 'weekdayShort')} · ${t('health.sleep.table.asleep')} ${fmt.durationShort(n.asleepS)}`,
            rows,
            theme,
          );
        },
        { axisPointer: { type: 'shadow', shadowStyle: { color: theme.grid, opacity: 0.35 } } },
      ),
      xAxis: categoryAxis(theme, days, {
        axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: (d: string) => fmt.day(d, 'dayShort') },
      }),
      yAxis: valueAxis(theme, {
        axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => `${fmt.num(v)} h` },
      }),
      series,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, stages, theme, selectedDay, fmt]);

  return (
    <ChartCard
      title={t('health.sleep.stages.title')}
      subtitle={t('health.sleep.stages.subtitle')}
      icon={Moon}
      table={{
        columns: [
          { key: 'day', label: t('health.sleep.table.date') },
          { key: 'asleep', label: t('health.sleep.table.asleep'), numeric: true },
          ...stages.map((s) => ({ key: s, label: stageLabel(s), numeric: true })),
          { key: 'eff', label: t('health.sleep.table.efficiency'), numeric: true },
        ],
        rows: [...data].reverse().map((n) => ({
          day: fmt.day(n.day, 'weekdayShort'),
          asleep: fmt.durationShort(n.asleepS),
          ...Object.fromEntries(stages.map((s) => [s, fmt.durationShort(stageSeconds(n, s))])),
          eff: n.efficiency === null ? '–' : fmt.pct(n.efficiency),
        })),
      }}
    >
      <EChart
        option={option}
        height={280}
        ariaLabel={t('health.sleep.stages.title')}
        onReady={onChartClick}
      />
    </ChartCard>
  );
}

/** Time asleep per night, its 7-day average and the goal line. */
export function DurationChart({ nights, goalMin }: { nights: SleepNight[]; goalMin: number }) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const data = useMemo(() => tracked(nights), [nights]);

  const { option, rows } = useMemo(() => {
    const pts = data.map((n) => ({ day: n.day, value: n.asleepS / HOUR }));
    const avg7 = rollingMeanByDay(pts, 7);
    const goalH = goalMin / 60;
    const all = [...pts.map((p) => p.value), goalH];
    const lo = Math.floor(Math.min(...all) - 0.5);
    const hi = Math.ceil(Math.max(...all) + 0.5);
    const dailyColor = theme.seqBlue[1]!;
    const avgColor = theme.seqBlue[3]!;
    const daily = lineSeries(theme, t('health.sleep.duration.daily'), pts.map((p) => [p.day, p.value]), dailyColor, {
      lineStyle: { width: 1.5, color: dailyColor, cap: 'round', join: 'round' },
      showSymbol: pts.length <= 60,
      symbolSize: 6,
    });
    const avg = lineSeries(theme, t('health.sleep.duration.avg7'), pts.map((p, i) => [p.day, avg7[i]]), avgColor, {
      markLine: {
        silent: true,
        symbol: 'none',
        animation: false,
        lineStyle: { color: theme.fg2, width: 1, type: 'solid', opacity: 0.7 },
        label: {
          show: true,
          position: 'insideEndTop',
          color: theme.fg2,
          fontSize: 11,
          formatter: t('health.sleep.goal.title', { value: fmt.durationShort(goalMin * 60) }),
        },
        data: [{ yAxis: goalH }],
      },
    });
    const opt = {
      grid: grid({ top: 34 }),
      legend: legend(theme, 'line', { data: [daily.name, avg.name], ...LEGEND_LINE_ICON }),
      tooltip: axisTooltip(theme, (params) => {
        const p = (params as { dataIndex: number }[])[0];
        const i = p?.dataIndex ?? -1;
        const pt = pts[i];
        if (!pt) return '';
        const rowsHtml = [{ color: dailyColor, label: daily.name as string, value: fmt.durationShort(pt.value * HOUR) }];
        const a = avg7[i];
        if (a !== null && a !== undefined)
          rowsHtml.push({ color: avgColor, label: avg.name as string, value: fmt.durationShort(a * HOUR) });
        return tooltipHtml(fmt.day(pt.day, 'weekdayShort'), rowsHtml, theme);
      }),
      xAxis: timeAxis(theme, { axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: dayAxisLabel(fmt) } }),
      yAxis: valueAxis(theme, {
        min: lo,
        max: hi,
        axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => `${fmt.num(v)} h` },
      }),
      series: [daily, avg],
    };
    const tableRows = [...pts].reverse().map((p) => {
      const i = pts.indexOf(p);
      return {
        day: fmt.day(p.day, 'weekdayShort'),
        asleep: fmt.durationShort(p.value * HOUR),
        avg: avg7[i] === null || avg7[i] === undefined ? '–' : fmt.durationShort(avg7[i]! * HOUR),
      };
    });
    return { option: opt, rows: tableRows };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, goalMin, theme, fmt]);

  return (
    <ChartCard
      title={t('health.sleep.duration.title')}
      subtitle={t('health.sleep.duration.subtitle')}
      icon={BedDouble}
      table={{
        columns: [
          { key: 'day', label: t('health.sleep.table.date') },
          { key: 'asleep', label: t('health.sleep.duration.daily'), numeric: true },
          { key: 'avg', label: t('health.sleep.duration.avg7'), numeric: true },
        ],
        rows,
      }}
    >
      <EChart option={option} height={260} ariaLabel={t('health.sleep.duration.title')} />
    </ChartCard>
  );
}

/** Day 0 of the schedule axis is 12:00 the day before, so every bedtime / wake-up is a positive number. */
const SHIFT = 720;

/** Floating bars from bedtime to wake-up: how regular is the sleep schedule? */
export function ScheduleChart({ nights, selectedDay, onSelect }: ChartProps) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const data = useMemo(() => nights.filter((n) => n.kind === 'night'), [nights]);
  const onChartClick = useChartClick((i) => {
    const n = data[i];
    if (n) onSelect(n.day);
  });
  const stats = useMemo(() => scheduleStats(data), [data]);
  const clock = (minutes: number) => fmt.time(wrapMinutes(minutes) * 60, 0);

  const { option, rows } = useMemo(() => {
    const days = data.map((n) => n.day);
    const bed = data.map(bedOffset);
    const wake = data.map((n, i) => {
      let w = wakeOffset(n);
      if (w <= bed[i]!) w += 1440;
      return w;
    });
    const lo = Math.floor((Math.min(...bed) + SHIFT) / 60) * 60 - 60;
    const hi = Math.ceil((Math.max(...wake) + SHIFT) / 60) * 60 + 60;
    const color = theme.seqBlue[2]!;
    const base = {
      ...barSeries(theme, 'base', bed.map((b) => b + SHIFT), 'transparent', { stack: 'schedule', silent: true }),
      itemStyle: { color: 'transparent' },
      emphasis: { disabled: true },
      tooltip: { show: false },
    };
    const sel = selectedDay ? days.indexOf(selectedDay) : -1;
    const visible: BarSeriesOption = {
      ...barSeries(theme, t('health.sleep.schedule.title'), wake.map((w, i) => w - bed[i]!), color, {
        stack: 'schedule',
        itemStyle: { color, borderColor: theme.surface, borderWidth: 1, borderRadius: 4 },
      }),
      markLine:
        stats.bed === null || stats.wake === null
          ? undefined
          : {
              silent: true,
              symbol: 'none',
              animation: false,
              lineStyle: { color: theme.fg2, width: 1, type: 'solid', opacity: 0.6 },
              label: {
                show: true,
                position: 'insideEndTop',
                color: theme.fg2,
                fontSize: 11,
                backgroundColor: theme.surface,
                padding: [1, 4],
                borderRadius: 4,
              },
              data: [
                { yAxis: stats.bed + SHIFT, label: { formatter: t('health.sleep.schedule.avgLine', { time: clock(stats.bed) }) } },
                { yAxis: stats.wake + SHIFT, label: { formatter: t('health.sleep.schedule.avgLine', { time: clock(stats.wake) }) } },
              ],
            },
      markArea:
        sel >= 0
          ? {
              silent: true,
              itemStyle: { color: theme.accent, opacity: 0.1 },
              data: [[{ xAxis: selectedDay as string }, { xAxis: selectedDay as string }]],
            }
          : undefined,
    };
    const opt = {
      grid: grid({ top: 12 }),
      tooltip: axisTooltip(
        theme,
        (params) => {
          const p = (params as { dataIndex: number }[])[0];
          const n = p ? data[p.dataIndex] : undefined;
          if (!n) return '';
          return tooltipHtml(
            fmt.day(n.day, 'weekdayShort'),
            [
              { color, label: t('health.sleep.schedule.bed'), value: fmt.time(n.bedTs, n.tzBedMin) },
              { color, label: t('health.sleep.schedule.wake'), value: fmt.time(n.wakeTs, n.tzWakeMin) },
              { color, label: t('health.sleep.table.inBed'), value: fmt.durationShort(n.inBedS) },
            ],
            theme,
          );
        },
        { axisPointer: { type: 'shadow', shadowStyle: { color: theme.grid, opacity: 0.35 } } },
      ),
      xAxis: categoryAxis(theme, days, {
        axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: (d: string) => fmt.day(d, 'dayShort') },
      }),
      yAxis: valueAxis(theme, {
        inverse: true,
        min: lo,
        max: hi,
        interval: 120,
        axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => clock(v - SHIFT) },
      }),
      series: [base, visible],
    };
    const tableRows = [...data].reverse().map((n) => ({
      day: fmt.day(n.day, 'weekdayShort'),
      bed: fmt.time(n.bedTs, n.tzBedMin),
      wake: fmt.time(n.wakeTs, n.tzWakeMin),
      inBed: fmt.durationShort(n.inBedS),
      asleep: n.asleepS > 0 ? fmt.durationShort(n.asleepS) : '–',
    }));
    return { option: opt, rows: tableRows };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, stats, theme, selectedDay, fmt]);

  return (
    <ChartCard
      title={t('health.sleep.schedule.title')}
      subtitle={t('health.sleep.schedule.subtitle')}
      icon={Clock}
      table={{
        columns: [
          { key: 'day', label: t('health.sleep.table.date') },
          { key: 'bed', label: t('health.sleep.table.bedtime'), numeric: true },
          { key: 'wake', label: t('health.sleep.table.wake'), numeric: true },
          { key: 'inBed', label: t('health.sleep.table.inBed'), numeric: true },
          { key: 'asleep', label: t('health.sleep.table.asleep'), numeric: true },
        ],
        rows,
      }}
    >
      <EChart
        option={option}
        height={260}
        ariaLabel={t('health.sleep.schedule.title')}
        onReady={onChartClick}
      />
    </ChartCard>
  );
}
