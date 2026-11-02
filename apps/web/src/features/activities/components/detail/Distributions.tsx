import { useMemo } from 'react';
import { BarChart3, Heart } from 'lucide-react';
import type { BarSeriesOption } from 'echarts';
import { M_PER_KM, M_PER_MI, type WorkoutDetail } from '@cadence/shared';
import { ChartCard, type TableView } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { barSeries, categoryAxis, itemTooltip, legend, tooltipHtml, valueAxis } from '@/components/charts/options';
import { useChartTheme } from '@/components/charts/theme';
import { clock, useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { isPaceSport } from '../../lib/display';
import { zoneOf } from '../../lib/route';
import { quantile, timeHistogram, type Prepared } from '../../lib/streams';

/** Smallest candidate step that gives at most ~24 bins over `range`. */
export function niceStep(range: number, candidates: number[]): number {
  for (const c of candidates) if (range / c <= 24) return c;
  return candidates[candidates.length - 1]!;
}

/** "< 107 bpm", "107–124 bpm", "≥ 160 bpm" for zone i given Z1..Z4 upper bounds. */
export function zoneRange(i: number, bounds: number[], t: (k: string, v?: Record<string, string | number>) => string): string {
  if (i === 0) return t('activities.zones.below', { bpm: bounds[0]! });
  if (i >= bounds.length) return t('activities.zones.above', { bpm: bounds[bounds.length - 1]! });
  return t('activities.zones.between', { from: bounds[i - 1]!, to: bounds[i]! - 1 });
}

export function HrZones({ w, zoneBounds }: { w: WorkoutDetail; zoneBounds: number[] }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const theme = useChartTheme();
  const { athlete } = useSettings();
  const secs = w.hrZones;
  const total = secs ? secs.reduce((a, b) => a + b, 0) : 0;
  const names = [1, 2, 3, 4, 5].map((z) => t(`common.zones.z${z}`));
  const option = useMemo(() => {
    if (!secs) return null;
    return {
      grid: { left: 4, right: 96, top: 4, bottom: 4, containLabel: true },
      xAxis: valueAxis(theme, { show: false, max: (v: { max: number }) => v.max * 1.02 }),
      yAxis: categoryAxis(theme, names, { inverse: true, axisLabel: { color: theme.fg2, fontSize: 12 } }),
      tooltip: itemTooltip(theme, (p: unknown) => {
        const { dataIndex } = p as { dataIndex: number };
        return tooltipHtml(
          names[dataIndex]!,
          [
            {
              color: theme.zones[dataIndex]!,
              value: fmt.duration(secs[dataIndex]!),
              label: `${fmt.pct(total ? secs[dataIndex]! / total : 0)} · ${zoneRange(dataIndex, zoneBounds, t)}`,
            },
          ],
          theme,
        );
      }),
      series: [
        barSeries(
          theme,
          t('activities.zones.title'),
          secs.map((s, i) => ({ value: s / 60, itemStyle: { color: theme.zones[i], borderRadius: [0, 4, 4, 0] } })),
          theme.zones[2]!,
          {
            horizontal: true,
            barMaxWidth: 18,
            label: {
              show: true,
              position: 'right',
              color: theme.fg2,
              fontSize: 11,
              formatter: (p: { dataIndex: number }) =>
                `${fmt.duration(secs[p.dataIndex]!)} · ${fmt.pct(total ? secs[p.dataIndex]! / total : 0)}`,
            },
          },
        ),
      ],
    };
  }, [secs, total, names, theme, fmt, zoneBounds, t]);
  if (!secs || total <= 0 || !option) return null;
  const table: TableView = {
    columns: [
      { key: 'zone', label: t('activities.zones.zone') },
      { key: 'range', label: t('activities.zones.range') },
      { key: 'time', label: t('activities.zones.time'), numeric: true },
      { key: 'share', label: t('activities.zones.share'), numeric: true },
    ],
    rows: secs.map((s, i) => ({ zone: names[i], range: zoneRange(i, zoneBounds, t), time: fmt.duration(s), share: fmt.pct(s / total) })),
  };
  return (
    <ChartCard
      title={t('activities.zones.title')}
      subtitle={athlete ? t('activities.zones.subtitle', { max: athlete.hr.maxHr }) : undefined}
      icon={Heart}
      table={table}
    >
      <EChart option={option} height={190} ariaLabel={t('activities.zones.title')} />
    </ChartCard>
  );
}

/** Time spent at each pace (or speed) while moving. */
export function PaceHistogram({ P, sport }: { P: Prepared; sport: string }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const theme = useChartTheme();
  const pace = isPaceSport(sport);
  const data = useMemo(() => {
    if (!P.speed || !P.dist) return null;
    const imperial = fmt.units === 'imperial';
    const unitM = sport === 'swim' ? (imperial ? 91.44 : 100) : imperial ? M_PER_MI : M_PER_KM;
    const conv = (mps: number) => (pace ? unitM / mps : imperial ? mps / (M_PER_MI / 3600) : mps * 3.6);
    const values = new Float64Array(P.n);
    for (let i = 0; i < P.n; i++) {
      const v = P.speed[i]!;
      values[i] = v > 0.3 && P.moving[i] ? conv(v) : NaN;
    }
    const lo0 = quantile(values, 0.02);
    const hi0 = quantile(values, 0.98);
    if (!Number.isFinite(lo0) || !(hi0 > lo0)) return null;
    const step = niceStep(hi0 - lo0, pace ? [5, 10, 15, 30, 60, 120] : [0.5, 1, 2, 5, 10]);
    const lo = Math.floor(lo0 / step) * step;
    const hi = Math.ceil(hi0 / step) * step + (Math.ceil(hi0 / step) * step === hi0 ? step : 0);
    const edges: number[] = [];
    for (let x = lo; x <= hi + 1e-9 && edges.length < 60; x += step) edges.push(x);
    if (edges.length < 2) return null;
    const bins = timeHistogram(P, (i) => values[i]!, edges);
    const label = (x: number) => (pace ? clock(x) : fmt.num(x, step < 1 ? 1 : 0));
    const total = bins.reduce((a, b) => a + b, 0);
    return { edges, bins, label, total, unit: fmt.paceParts(1, sport).unit };
  }, [P, sport, pace, fmt]);
  const option = useMemo(() => {
    if (!data) return null;
    const cats = data.bins.map((_, i) => data.label(data.edges[i]!));
    return {
      grid: { left: 4, right: 8, top: 12, bottom: 4, containLabel: true },
      xAxis: categoryAxis(theme, cats),
      yAxis: valueAxis(theme, { axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => `${v}′` } }),
      tooltip: itemTooltip(theme, (p: unknown) => {
        const i = (p as { dataIndex: number }).dataIndex;
        return tooltipHtml(
          `${data.label(data.edges[i]!)}–${data.label(data.edges[i + 1]!)} ${data.unit}`,
          [{ color: theme.series[1]!, value: fmt.duration(data.bins[i]!), label: fmt.pct(data.total ? data.bins[i]! / data.total : 0) }],
          theme,
        );
      }),
      series: [barSeries(theme, pace ? t('activities.histograms.pace') : t('activities.histograms.speed'), data.bins.map((s) => s / 60), theme.series[1]!)],
    };
  }, [data, theme, fmt, pace, t]);
  if (!data || !option) return null;
  const table: TableView = {
    columns: [
      { key: 'bin', label: `${t('activities.histograms.bin')} (${data.unit})` },
      { key: 'time', label: t('activities.histograms.time'), numeric: true },
      { key: 'share', label: t('activities.histograms.share'), numeric: true },
    ],
    rows: data.bins.map((s, i) => ({
      bin: `${data.label(data.edges[i]!)}–${data.label(data.edges[i + 1]!)}`,
      time: fmt.duration(s),
      share: fmt.pct(data.total ? s / data.total : 0),
    })),
  };
  return (
    <ChartCard
      title={pace ? t('activities.histograms.pace') : t('activities.histograms.speed')}
      subtitle={`${t('activities.histograms.subtitle')} · ${data.unit}`}
      icon={BarChart3}
      table={table}
    >
      <EChart option={option} height={220} ariaLabel={pace ? t('activities.histograms.pace') : t('activities.histograms.speed')} />
    </ChartCard>
  );
}

/** Time at each heart rate (5 bpm bins), colored by HR zone. */
export function HrHistogram({ P, zoneBounds }: { P: Prepared; zoneBounds: number[] }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const theme = useChartTheme();
  const data = useMemo(() => {
    if (!P.hr) return null;
    const q0 = quantile(P.hr, 0.01);
    const q1 = quantile(P.hr, 0.995) + 1;
    const step = niceStep(q1 - q0, [1, 2, 5, 10]);
    const lo = Math.floor(q0 / step) * step;
    const hi = Math.ceil(q1 / step) * step;
    if (!(hi > lo)) return null;
    const edges: number[] = [];
    for (let x = lo; x <= hi; x += step) edges.push(x);
    const bins = timeHistogram(P, (i) => (P.hr![i - 1]! + P.hr![i]!) / 2, edges, false);
    const total = bins.reduce((a, b) => a + b, 0);
    return { edges, bins, total, zones: bins.map((_, i) => zoneOf((edges[i]! + edges[i + 1]!) / 2, zoneBounds)) };
  }, [P, zoneBounds]);
  const option = useMemo(() => {
    if (!data) return null;
    const cats = data.bins.map((_, i) => String(data.edges[i]));
    const names = [1, 2, 3, 4, 5].map((z) => `Z${z}`);
    const series: BarSeriesOption[] = names.map((name, z) =>
      barSeries(
        theme,
        name,
        data.bins.map((s, i) => (data.zones[i] === z ? s / 60 : null)),
        theme.zones[z]!,
        { stack: 'hr' },
      ),
    );
    return {
      grid: { left: 4, right: 8, top: 34, bottom: 4, containLabel: true },
      legend: legend(theme, 'rect'),
      xAxis: categoryAxis(theme, cats),
      yAxis: valueAxis(theme, { axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => `${v}′` } }),
      tooltip: itemTooltip(theme, (p: unknown) => {
        const i = (p as { dataIndex: number }).dataIndex;
        return tooltipHtml(
          data.edges[i + 1]! - data.edges[i]! > 1 ? `${data.edges[i]}–${data.edges[i + 1]! - 1} bpm` : `${data.edges[i]} bpm`,
          [
            {
              color: theme.zones[data.zones[i]!]!,
              value: fmt.duration(data.bins[i]!),
              label: `Z${data.zones[i]! + 1} · ${fmt.pct(data.total ? data.bins[i]! / data.total : 0)}`,
            },
          ],
          theme,
        );
      }),
      series,
    };
  }, [data, theme, fmt]);
  if (!data || !option) return null;
  const table: TableView = {
    columns: [
      { key: 'bin', label: `${t('activities.histograms.bin')} (bpm)` },
      { key: 'zone', label: t('activities.zones.zone') },
      { key: 'time', label: t('activities.histograms.time'), numeric: true },
      { key: 'share', label: t('activities.histograms.share'), numeric: true },
    ],
    rows: data.bins.map((s, i) => ({
      bin: data.edges[i + 1]! - data.edges[i]! > 1 ? `${data.edges[i]}–${data.edges[i + 1]! - 1}` : `${data.edges[i]}`,
      zone: `Z${data.zones[i]! + 1}`,
      time: fmt.duration(s),
      share: fmt.pct(data.total ? s / data.total : 0),
    })),
  };
  return (
    <ChartCard title={t('activities.histograms.hr')} subtitle={`${t('activities.histograms.subtitleAll')} · bpm`} icon={Heart} table={table}>
      <EChart option={option} height={240} ariaLabel={t('activities.histograms.hr')} />
    </ChartCard>
  );
}
