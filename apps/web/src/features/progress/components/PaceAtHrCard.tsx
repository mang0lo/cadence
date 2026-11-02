import { useEffect, useMemo, useState, type FocusEvent } from 'react';
import { HeartPulse } from 'lucide-react';
import type { EChartsOption } from 'echarts';
import { sportInfo, type PaceAtHrResponse, type ProgressHrBand } from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import {
  axisTooltip,
  barSeries,
  categoryAxis,
  grid,
  itemTooltip,
  lineSeries,
  tooltipHtml,
  valueAxis,
} from '@/components/charts/options';
import { sportColor, useChartTheme, type ChartTheme } from '@/components/charts/theme';
import { Delta, EmptyState, ErrorState, Input, SegmentedControl } from '@/components/ui';
import { useFormat, type Formatter } from '@/lib/format';
import { useT, type TFunction } from '@/lib/i18n';
import { usePaceAtHr, useSaveHrBand, type RangeParams } from '../api';
import { bucketLabel, chartLegend, clockAxis } from '../chart';
import { speedFormat, type TrendFormat } from '../format';
import { ChartSkeleton } from './common';

const HEIGHT = 240;
type BandKey = PaceAtHrResponse['suggestions'][number]['key'] | 'custom';

function mainOption(
  data: PaceAtHrResponse,
  o: { theme: ChartTheme; fmt: Formatter; t: TFunction; tf: TrendFormat; color: string },
): EChartsOption {
  const { theme, fmt, t, tf, color } = o;
  const cats = data.months.map((m) => bucketLabel(fmt, m.month));
  const values = data.months.map((m) => (m.speed === null ? null : tf.toChart(m.speed)));
  let trend: (number | null)[] = [];
  if (data.fit) {
    const f = data.fit;
    const mid = (m: string) => Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 15) / 1000;
    trend = data.months.map((m) => {
      const ts = mid(m.month);
      if (ts < f.startTs - 1 || ts > f.endTs + 1) return null;
      return tf.toChart(f.startValue + (f.slopePerDay * (ts - f.startTs)) / 86400);
    });
  }
  const names = { value: t('progress.paceAtHr.legend.value'), trend: t('progress.trends.legend.trend') };
  return {
    grid: grid({ top: trend.length ? 40 : 16, right: 28 }),
    legend: trend.length ? chartLegend(theme, 'line', { data: [names.value, names.trend] }) : undefined,
    xAxis: categoryAxis(theme, cats),
    yAxis: valueAxis(theme, {
      scale: true,
      inverse: tf.inverse,
      ...(tf.inverse ? clockAxis([...values, ...trend].filter((v): v is number => v !== null), 4) : {}),
      axisLabel: { color: theme.muted, fontSize: 11, formatter: (n: number) => tf.axisLabel(n) },
    }),
    tooltip: axisTooltip(theme, (params: unknown) => {
      const i = (params as { dataIndex: number }[])[0]?.dataIndex ?? 0;
      const m = data.months[i]!;
      const rows = [
        {
          color,
          label: names.value,
          value: m.speed === null ? t('progress.paceAtHr.tooLittle') : tf.format(m.speed),
        },
        { color: 'transparent', label: t('progress.paceAtHr.timeInBand'), value: fmt.durationShort(m.seconds) },
        { color: 'transparent', label: t('progress.common.activities'), value: fmt.int(m.workouts) },
      ];
      return tooltipHtml(bucketLabel(fmt, m.month, 'long'), rows, theme);
    }),
    series: [
      lineSeries(theme, names.value, values, color, { showSymbol: true, symbolSize: 8, connectNulls: false }),
      ...(trend.length
        ? [lineSeries(theme, names.trend, trend, theme.fg, { silent: true, lineStyle: { width: 2, color: theme.fg, type: [6, 4] } })]
        : []),
    ],
  } as EChartsOption;
}

function distributionOption(
  dist: NonNullable<PaceAtHrResponse['hrDistribution']>,
  band: ProgressHrBand,
  o: { theme: ChartTheme; fmt: Formatter; color: string },
): EChartsOption {
  const { theme, fmt, color } = o;
  const bpms = dist.seconds.map((_, i) => dist.lo + i);
  return {
    grid: grid({ top: 4, bottom: 0, left: 0, right: 0 }),
    xAxis: categoryAxis(theme, bpms, {
      axisLabel: { color: theme.muted, fontSize: 10, interval: (i: number) => (dist.lo + i) % 10 === 0 },
    }),
    yAxis: { type: 'value', show: false },
    tooltip: itemTooltip(theme, (p: unknown) => {
      const { dataIndex } = p as { dataIndex: number };
      return tooltipHtml(`${bpms[dataIndex]} bpm`, [{ color, label: '', value: fmt.durationShort(dist.seconds[dataIndex]!) }], theme);
    }),
    series: [
      barSeries(
        theme,
        'hr',
        dist.seconds.map((s, i) => ({
          value: s,
          itemStyle: { color: bpms[i]! >= band.lo && bpms[i]! < band.hi ? color : theme.axis, borderRadius: [2, 2, 0, 0] },
        })),
        theme.axis,
        { barCategoryGap: '15%', barMaxWidth: 12 },
      ),
    ],
  } as EChartsOption;
}

export function PaceAtHrCard({ sport, range }: { sport: string; range: RangeParams | null }) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const save = useSaveHrBand();
  const [band, setBand] = useState<ProgressHrBand | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  useEffect(() => {
    setBand(null);
    setCustomOpen(false);
  }, [sport]);
  const single = sport !== 'all' && sportInfo(sport).distance;
  const q = usePaceAtHr(single ? sport : null, range, band);
  const data = single ? q.data : undefined;
  const tf = speedFormat(fmt, data?.sport ?? sport);
  const color = sportColor(theme, sport);
  const option = useMemo(
    () => (data && data.months.some((m) => m.speed !== null) ? mainOption(data, { theme, fmt, t, tf, color }) : null),
    [data, theme, fmt, t, tf, color],
  );
  const distOption = useMemo(
    () => (data?.hrDistribution ? distributionOption(data.hrDistribution, data.band, { theme, fmt, color }) : null),
    [data, theme, fmt, color],
  );
  // custom inputs show inclusive bounds (like the labels): band [lo, hi) ↔ inputs lo … hi − 1
  const [lo, setLo] = useState('');
  const [hi, setHi] = useState('');
  const bandKey = data ? `${data.band.lo}-${data.band.hi}` : '';
  useEffect(() => {
    // while the custom inputs are open they belong to the user; never overwrite what is being typed
    if (data && !customOpen) {
      setLo(String(data.band.lo));
      setHi(String(data.band.hi - 1));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bandKey, customOpen]);

  const pick = (b: ProgressHrBand) => {
    setBand(b);
    void save(sport, b).catch(() => undefined);
  };
  const applyCustom = () => {
    const a = Math.round(Number(lo));
    const b = Math.round(Number(hi)) + 1;
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 30 || b > 240 || b <= a) return;
    if (data && data.band.lo === a && data.band.hi === b) return;
    pick({ lo: a, hi: b });
  };
  /** Apply when focus leaves the pair of inputs (not when it moves from one to the other). */
  const onBlurGroup = (e: FocusEvent<HTMLInputElement>) => {
    if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node | null)) applyCustom();
  };

  const suggestions = useMemo(() => {
    const seen = new Set<string>();
    return (data?.suggestions ?? []).filter((s) => {
      const k = `${s.lo}-${s.hi}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [data]);
  const activeKey: BandKey = customOpen
    ? 'custom'
    : (suggestions.find((s) => data && s.lo === data.band.lo && s.hi === data.band.hi)?.key ?? 'custom');

  const table = useMemo(() => {
    if (!data) return undefined;
    return {
      columns: [
        { key: 'month', label: t('progress.yoy.month') },
        { key: 'pace', label: t('progress.paceAtHr.legend.value'), numeric: true },
        { key: 'time', label: t('progress.paceAtHr.timeInBand'), numeric: true },
        { key: 'distance', label: t('common.distance'), numeric: true },
        { key: 'workouts', label: t('progress.common.activities'), numeric: true },
      ],
      rows: [...data.months].reverse().map((m) => ({
        month: bucketLabel(fmt, m.month, 'long'),
        pace: m.speed === null ? '–' : tf.format(m.speed),
        time: fmt.durationShort(m.seconds),
        distance: fmt.distance(m.distanceM),
        workouts: fmt.int(m.workouts),
      })),
    };
  }, [data, fmt, t, tf]);

  const title = t(tf.inverse ? 'progress.paceAtHr.title' : 'progress.paceAtHr.titleSpeed');
  if (!single) {
    return (
      <ChartCard title={t('progress.paceAtHr.title')} icon={HeartPulse}>
        <EmptyState icon={HeartPulse} title={t('progress.paceAtHr.pickSport')} description={t('progress.paceAtHr.emptyHint')} />
      </ChartCard>
    );
  }
  const first = data?.fit?.startValue;
  const last = data?.fit?.endValue;
  return (
    <ChartCard
      title={title}
      subtitle={data ? t('progress.paceAtHr.subtitle', { lo: data.band.lo, hi: data.band.hi - 1 }) : undefined}
      icon={HeartPulse}
      table={table}
      footer={t('progress.paceAtHr.note')}
    >
      {q.error ? (
        <ErrorState error={q.error} />
      ) : !data ? (
        <ChartSkeleton height={HEIGHT + 120} />
      ) : !data.hrDistribution ? (
        <EmptyState title={t('progress.paceAtHr.empty')} description={t('progress.paceAtHr.emptyHint')} />
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <SegmentedControl
              size="sm"
              value={activeKey}
              label={t('progress.paceAtHr.band')}
              onChange={(k) => {
                if (k === 'custom') return setCustomOpen(true);
                setCustomOpen(false);
                const s = suggestions.find((x) => x.key === k);
                if (s) pick({ lo: s.lo, hi: s.hi });
              }}
              items={[
                ...suggestions.map((s) => ({
                  value: s.key as BandKey,
                  label: `${t(`progress.paceAtHr.bands.${s.key}`)} · ${s.lo}–${s.hi - 1}`,
                })),
                { value: 'custom' as BandKey, label: t('progress.paceAtHr.bands.custom') },
              ]}
            />
            {activeKey === 'custom' && (
              <div className="flex items-center gap-1.5">
                <Input
                  inputMode="numeric"
                  aria-label={t('progress.paceAtHr.from')}
                  value={lo}
                  onChange={(e) => setLo(e.target.value)}
                  onBlur={onBlurGroup}
                  onKeyDown={(e) => e.key === 'Enter' && applyCustom()}
                  className="h-8 w-16 text-xs"
                />
                <span className="text-xs text-fg-3">–</span>
                <Input
                  inputMode="numeric"
                  aria-label={t('progress.paceAtHr.to')}
                  value={hi}
                  onChange={(e) => setHi(e.target.value)}
                  onBlur={onBlurGroup}
                  onKeyDown={(e) => e.key === 'Enter' && applyCustom()}
                  className="h-8 w-16 text-xs"
                />
                <span className="text-xs text-fg-3">bpm</span>
              </div>
            )}
          </div>
          {distOption && (
            <div className="mb-3">
              <EChart
                option={distOption}
                height={56}
                ariaLabel={t('progress.paceAtHr.distribution')}
                onEvents={{
                  click: (p: { dataIndex: number }) => {
                    const bpm = data.hrDistribution!.lo + p.dataIndex;
                    const start = Math.round((bpm - 5) / 5) * 5;
                    setCustomOpen(false);
                    pick({ lo: start, hi: start + 10 });
                  },
                }}
              />
              <p className="text-[11px] text-fg-3">{t('progress.paceAtHr.distribution')}</p>
            </div>
          )}
          {data.change !== null && first !== undefined && last !== undefined && (
            <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <Delta
                value={Math.abs(data.change) < 0.01 ? 0 : data.change}
                upIsGood
                className="text-sm"
                text={
                  Math.abs(data.change) < 0.01
                    ? t('progress.paceAtHr.stable')
                    : t(data.change > 0 ? 'progress.paceAtHr.faster' : 'progress.paceAtHr.slower', {
                        value: `${fmt.num(Math.abs(data.change) * 100, 1)} %`,
                      })
                }
              />
              <span className="text-xs text-fg-3">
                {tf.format(first)} → {tf.format(last)}
              </span>
            </div>
          )}
          {option ? (
            <EChart option={option} height={HEIGHT} loading={q.isFetching} ariaLabel={title} />
          ) : (
            <EmptyState title={t('progress.paceAtHr.empty')} className="h-[240px]" />
          )}
        </>
      )}
    </ChartCard>
  );
}
