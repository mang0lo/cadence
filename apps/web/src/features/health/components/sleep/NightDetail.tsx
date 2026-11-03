import { useMemo } from 'react';
import type { CustomSeriesOption } from 'echarts';
import { Activity, Droplets, HeartPulse, Moon, Thermometer, Wind, type LucideIcon } from 'lucide-react';
import type { DailyMetric, SleepNight, SleepNightDetail, SleepStage, TimedValue } from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { categoryAxis, grid, itemTooltip, axisTooltip, lineSeries, timeAxis, tooltipHtml, valueAxis } from '@/components/charts/options';
import { useChartTheme } from '@/components/charts/theme';
import { Card, CardHeader, ErrorState, Skeleton, Stat, StatRow } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { addDays } from '@/lib/time';
import { DayNav } from '../DayNav';
import { Spark } from '../Spark';
import { TrendDelta } from '../TrendDelta';
import { useDaily } from '../../lib/hooks';
import { measureColor, type MeasureKey } from '../../lib/colors';
import { useMetricFormat } from '../../lib/metrics';
import { stageColor, stageSeconds, STAGE_STACK } from '../../lib/sleep';
import { useStageLabel } from './SleepCharts';

const HR = 'HKQuantityTypeIdentifierHeartRate';
const HRV = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN';
const RESP = 'HKQuantityTypeIdentifierRespiratoryRate';
const SPO2 = 'HKQuantityTypeIdentifierOxygenSaturation';
const WRIST = 'HKQuantityTypeIdentifierAppleSleepingWristTemperature';

/** Hypnogram: one row per stage, one rounded bar per stage segment; times are the local wall clock of the night. */
function Hypnogram({ night }: { night: SleepNightDetail }) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const stageLabel = useStageLabel();

  const { option, rows, height } = useMemo(() => {
    const rowStages: SleepStage[] = night.staged ? ['awake', 'rem', 'core', 'deep'] : ['awake', 'asleep'];
    if (night.staged && night.unspecS > 0) rowStages.splice(1, 0, 'asleep');
    const off = night.tzBedMin * 60;
    const items = night.segments
      .map((seg) => ({
        value: [(seg.startTs + off) * 1000, (seg.endTs + off) * 1000, rowStages.indexOf(seg.stage)],
        stage: seg.stage,
        seg,
        itemStyle: { color: stageColor(theme, seg.stage) },
      }))
      .filter((i) => i.value[2]! >= 0);
    const hypnogramSeries: CustomSeriesOption = {
      type: 'custom',
      clip: true,
      encode: { x: [0, 1], y: 2 },
      data: items,
      renderItem: (_params, api) => {
        const start = api.coord([api.value(0), api.value(2)]);
        const end = api.coord([api.value(1), api.value(2)]);
        const band = (api.size?.([0, 1]) as number[])[1] ?? 30;
        const h = Math.min(band * 0.62, 26);
        return {
          type: 'rect',
          shape: { x: start[0]!, y: start[1]! - h / 2, width: Math.max(end[0]! - start[0]!, 1.5), height: h, r: 3 },
          style: { fill: api.visual('color') as string },
        };
      },
    };
    const opt = {
      useUTC: true,
      grid: grid({ top: 6, bottom: 4 }),
      tooltip: itemTooltip(theme, (params) => {
        const p = params as { data?: { seg: { startTs: number; endTs: number }; stage: SleepStage } };
        const d = p.data;
        if (!d) return '';
        return tooltipHtml(
          `${fmt.time(d.seg.startTs, night.tzBedMin)} – ${fmt.time(d.seg.endTs, night.tzBedMin)}`,
          [{ color: stageColor(theme, d.stage), label: stageLabel(d.stage), value: fmt.durationShort(d.seg.endTs - d.seg.startTs) }],
          theme,
        );
      }),
      xAxis: timeAxis(theme, {
        min: (night.bedTs + off) * 1000,
        max: (night.wakeTs + off) * 1000,
        axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: (v: number) => fmt.time(v / 1000, 0) },
      }),
      yAxis: categoryAxis(
        theme,
        rowStages.map((s) => stageLabel(s, true)),
        {
          inverse: true,
          axisLine: { show: false },
          splitLine: { show: true, lineStyle: { color: theme.grid, width: 1, type: 'solid' } },
          axisLabel: { color: theme.fg2, fontSize: 12 },
        },
      ),
      series: [hypnogramSeries],
    };
    const tableRows = night.segments.map((seg) => ({
      stage: stageLabel(seg.stage),
      start: fmt.time(seg.startTs, night.tzBedMin),
      end: fmt.time(seg.endTs, night.tzBedMin),
      duration: fmt.durationShort(seg.endTs - seg.startTs),
    }));
    return { option: opt, rows: tableRows, height: 56 + rowStages.length * 38 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [night, theme, fmt]);

  const legendStages = STAGE_STACK.filter((s) => stageSeconds(night, s) > 0 || s === 'awake').reverse();

  return (
    <ChartCard
      title={t('health.sleep.night.hypnogram')}
      subtitle={t('health.sleep.night.subtitle')}
      icon={Moon}
      table={{
        columns: [
          { key: 'stage', label: t('health.sleep.night.stage') },
          { key: 'start', label: t('health.sleep.night.start'), numeric: true },
          { key: 'end', label: t('health.sleep.night.end'), numeric: true },
          { key: 'duration', label: t('health.sleep.night.duration'), numeric: true },
        ],
        rows,
      }}
      footer={
        <div className="flex flex-wrap gap-x-5 gap-y-1.5">
          {legendStages.map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5 text-xs text-fg-2">
              <span className="inline-block size-2.5 rounded-[3px]" style={{ background: stageColor(theme, s) }} aria-hidden />
              {stageLabel(s)}
              <span className="font-medium text-fg tabular">{fmt.durationShort(stageSeconds(night, s))}</span>
            </span>
          ))}
        </div>
      }
    >
      {!night.staged && <p className="mb-2 text-xs text-fg-3">{t('health.sleep.night.noStages')}</p>}
      <EChart option={option} height={height} ariaLabel={t('health.sleep.night.hypnogram')} />
    </ChartCard>
  );
}

/** One physiology series of the night on the same clock as the hypnogram. */
function NightSeriesChart({
  title,
  icon,
  metric,
  measure,
  points,
  night,
}: {
  title: string;
  icon: LucideIcon;
  metric: string;
  measure: MeasureKey;
  points: TimedValue[];
  night: SleepNightDetail;
}) {
  const t = useT();
  const fmt = useFormat();
  const m = useMetricFormat();
  const theme = useChartTheme();
  const color = measureColor(theme, measure);
  const unit = m.unitLabel(metric);
  const off = night.tzBedMin * 60;

  const option = useMemo(() => {
    const data = points.map((p) => [(p.ts + off) * 1000, m.toDisplay(metric, p.value)]);
    const s = lineSeries(theme, title, data, color, { showSymbol: points.length <= 40, symbolSize: 7 });
    return {
      useUTC: true,
      grid: grid({ top: 10 }),
      tooltip: axisTooltip(theme, (params) => {
        const p = (params as { dataIndex: number }[])[0];
        const pt = p ? points[p.dataIndex] : undefined;
        if (!pt) return '';
        return tooltipHtml(fmt.time(pt.ts, night.tzBedMin), [{ color, label: title, value: m.value(metric, pt.value) }], theme);
      }),
      xAxis: timeAxis(theme, {
        min: (night.bedTs + off) * 1000,
        max: (night.wakeTs + off) * 1000,
        axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: (v: number) => fmt.time(v / 1000, 0) },
      }),
      yAxis: valueAxis(theme, { scale: true, axisLabel: { color: theme.muted, fontSize: 11 } }),
      series: [s],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, night, theme, fmt, m, metric]);

  return (
    <ChartCard
      title={`${title}${unit ? ` (${unit})` : ''}`}
      icon={icon}
      table={{
        columns: [
          { key: 'time', label: t('health.common.time') },
          { key: 'value', label: unit || t('health.common.value'), numeric: true },
        ],
        rows: points.map((p) => ({ time: fmt.time(p.ts, night.tzBedMin), value: m.plain(metric, p.value) })),
      }}
    >
      {points.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg-3">{t('health.sleep.physiology.noSamples')}</p>
      ) : (
        <EChart option={option} height={170} ariaLabel={title} />
      )}
    </ChartCard>
  );
}

function PhysiologyPanel({ night }: { night: SleepNightDetail }) {
  const t = useT();
  const m = useMetricFormat();
  const p = night.physiology;
  const wrist = useDaily([WRIST], addDays(night.day, -30), night.day);
  const wristSpark = (wrist.data?.[WRIST] ?? []).map((d: DailyMetric) => d.value);
  const wd = p.wristTemp?.delta;
  const wristDelta = wd === null || wd === undefined ? null : m.delta(WRIST, wd);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t('health.sleep.physiology.title')} subtitle={t('health.sleep.physiology.subtitle')} icon={HeartPulse} />
        <StatRow>
          <Stat
            label={t('health.sleep.physiology.hrLowest')}
            value={m.parts(HR, p.hrMin).value}
            unit={m.parts(HR, p.hrMin).unit}
            hint={p.hrAvg !== null ? t('health.sleep.physiology.avg', { value: m.value(HR, p.hrAvg) }) : undefined}
          />
          <Stat label={t('health.sleep.physiology.hrv')} value={m.parts(HRV, p.hrvAvg).value} unit={m.parts(HRV, p.hrvAvg).unit} />
          <Stat label={t('health.sleep.physiology.resp')} value={m.parts(RESP, p.respAvg).value} unit={m.parts(RESP, p.respAvg).unit} />
          <Stat label={t('health.sleep.physiology.spo2')} value={m.parts(SPO2, p.spo2Avg).value} unit={m.parts(SPO2, p.spo2Avg).unit} />
          <Stat
            label={t('health.sleep.physiology.wrist')}
            value={p.wristTemp ? m.parts(WRIST, p.wristTemp.value).value : '–'}
            unit={p.wristTemp ? m.parts(WRIST, p.wristTemp.value).unit : ''}
            delta={wristDelta ? <TrendDelta value={wristDelta.value} text={wristDelta.text} good={null} /> : undefined}
            hint={
              p.wristTemp?.baseline !== null && p.wristTemp?.baseline !== undefined
                ? t('health.sleep.physiology.vsBaseline', { days: 30 })
                : undefined
            }
            trend={wristSpark.length > 1 ? <Spark data={wristSpark} height={24} ariaLabel={t('health.sleep.physiology.last30')} /> : undefined}
          />
        </StatRow>
      </Card>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-2">
        <NightSeriesChart title={t('health.sleep.physiology.hr')} icon={HeartPulse} metric={HR} measure="heartRate" points={p.hr} night={night} />
        <NightSeriesChart title={t('health.sleep.physiology.hrv')} icon={Activity} metric={HRV} measure="hrv" points={p.hrv} night={night} />
        <NightSeriesChart title={t('health.sleep.physiology.resp')} icon={Wind} metric={RESP} measure="respiratory" points={p.resp} night={night} />
        <NightSeriesChart title={t('health.sleep.physiology.spo2')} icon={Droplets} metric={SPO2} measure="spo2" points={p.spo2} night={night} />
      </div>
    </div>
  );
}

/** Selected night: navigation, key numbers, hypnogram and what the watch measured while you slept. */
export function NightDetail({
  nights,
  day,
  onDayChange,
  minDay,
  maxDay,
}: {
  /** All main nights (for previous / next navigation). */
  nights: SleepNight[];
  day: string;
  onDayChange: (day: string) => void;
  minDay?: string;
  maxDay?: string;
}) {
  const t = useT();
  const fmt = useFormat();
  const q = useApi<SleepNightDetail>(['health', 'sleep', 'night', day], '/health/sleep/night', { day });
  const n = q.data && q.data.day === day ? q.data : null;
  const days = useMemo(() => nights.map((x) => x.day), [nights]);

  return (
    <section className="space-y-4" aria-label={t('health.sleep.night.title', { date: fmt.day(day, 'day') })}>
      <Card>
        <CardHeader
          title={t('health.sleep.night.title', { date: fmt.day(day, 'weekday') })}
          subtitle={n?.source ?? undefined}
          icon={Moon}
          actions={
            <DayNav
              day={day}
              onChange={onDayChange}
              days={days}
              min={minDay}
              max={maxDay}
              prevLabel={t('health.sleep.night.prev')}
              nextLabel={t('health.sleep.night.next')}
              pickLabel={t('health.sleep.night.pick')}
            />
          }
        />
        {q.error ? (
          <ErrorState error={q.error} />
        ) : !n ? (
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i}>
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-2 h-7 w-20" />
              </div>
            ))}
          </div>
        ) : (
          <StatRow>
            <Stat label={t('health.sleep.night.bedtime')} value={n.timed ? fmt.time(n.bedTs, n.tzBedMin) : '–'} />
            <Stat label={t('health.sleep.night.wake')} value={n.timed ? fmt.time(n.wakeTs, n.tzWakeMin) : '–'} />
            <Stat label={t('health.sleep.night.inBed')} value={fmt.durationShort(n.inBedS)} />
            <Stat label={t('health.sleep.night.asleep')} value={n.asleepS > 0 ? fmt.durationShort(n.asleepS) : '–'} />
            <Stat label={t('health.sleep.night.efficiency')} value={n.efficiency !== null && n.asleepS > 0 ? fmt.pct(n.efficiency) : '–'} />
            <Stat label={t('health.sleep.night.awakenings')} value={fmt.int(n.awakenings)} />
            <Stat label={t('health.sleep.night.latency')} value={n.latencyS !== null ? fmt.durationShort(n.latencyS) : '–'} />
          </StatRow>
        )}
      </Card>
      {n && <Hypnogram night={n} />}
      {n && <PhysiologyPanel night={n} />}
    </section>
  );
}
