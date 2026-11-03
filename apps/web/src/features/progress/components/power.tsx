import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { CheckCircle2, Gauge, LineChart as LineChartIcon, Medal, TrendingUp, Zap } from 'lucide-react';
import type { ECharts, EChartsOption } from 'echarts';
import {
  workoutTitle,
  type ProgressFtpResponse,
  type ProgressPowerCompare,
  type ProgressPowerCurve,
  type ProgressPowerCurveResponse,
  type ProgressPowerEffort,
} from '@cadence/shared';
import { ChartCard, type TableView } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { areaSeries, axisTooltip, categoryAxis, escapeHtml, grid, lineSeries, valueAxis } from '@/components/charts/options';
import { useChartTheme, type ChartTheme } from '@/components/charts/theme';
import { Badge, Button, Card, CardHeader, Delta, EmptyState, ErrorState, Skeleton, Stat } from '@/components/ui';
import { useFormat, type Formatter } from '@/lib/format';
import { useI18n, useT, type Lang, type TFunction } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { sportLabel } from '@/lib/sports';
import { chartLegend, hitLayer } from '../chart';
import { signedRounded } from '../format';
import {
  curveName,
  durationLabel,
  formatPower,
  historyBucketLabel,
  isCycling,
  KEY_DURATIONS,
  POWER_TICKS,
  powerValue,
  type PowerUnit,
} from '../power';
import { ActivityLink, ChartSkeleton } from './common';

const CURVE_HEIGHT = 320;
const HISTORY_HEIGHT = 260;
/** Clicks within this distance (px) of a curve point open its activity. */
const HIT_PX = 36;

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

export interface CurveSeries {
  name: string;
  color: string;
  curve: ProgressPowerCurve;
}

/** The curves of a response in legend order: the period (slot 1), then the comparison (slot 2). */
export function curveSeries(data: ProgressPowerCurveResponse, theme: ChartTheme, t: TFunction, fmt: Formatter): CurveSeries[] {
  const out: CurveSeries[] = [
    { name: curveName(t, fmt, data.period, 'current', data.current), color: theme.series[0]!, curve: data.current },
  ];
  if (data.comparison) {
    const kind = data.compare === 'allTime' ? 'allTime' : 'previous';
    out.push({ name: curveName(t, fmt, data.period, kind, data.comparison), color: theme.series[1]!, curve: data.comparison });
  }
  return out;
}

/** Activity title + date of an effort (table cells). */
function EffortCell({ e }: { e: ProgressPowerEffort | undefined }) {
  const fmt = useFormat();
  if (!e) return <span className="text-fg-3">–</span>;
  return (
    <span className="inline-flex min-w-0 flex-col">
      <ActivityLink w={e} className="truncate" />
      <span className="text-xs text-fg-3">{fmt.date(e.startTs, e.tzMin, 'day')}</span>
    </span>
  );
}

interface TipEntry {
  color: string;
  name: string;
  effort: ProgressPowerEffort;
}

/** Tooltip: per curve a line key, the value and the curve, then W/kg (or W) · activity · date in small print. */
function powerTipHtml(
  theme: ChartTheme,
  title: string,
  entries: TipEntry[],
  o: { fmt: Formatter; lang: Lang; unit: PowerUnit; footer: string },
): string {
  const head = `<div style="color:${theme.muted};font-size:11px;margin-bottom:4px">${escapeHtml(title)}</div>`;
  const body = entries
    .map((e) => {
      const v = powerValue(e.effort, o.unit);
      const other = o.unit === 'wkg' ? formatPower(o.fmt, e.effort.watts, 'w') : e.effort.wkg !== null ? formatPower(o.fmt, e.effort.wkg, 'wkg') : null;
      const detail = [other, workoutTitle(e.effort, o.lang), o.fmt.date(e.effort.startTs, e.effort.tzMin, 'day')]
        .filter((x): x is string => !!x)
        .join(' · ');
      return (
        `<div style="display:flex;align-items:center;gap:8px;line-height:18px">` +
        `<span style="display:inline-block;width:10px;height:2px;border-radius:1px;background:${e.color}"></span>` +
        `<span style="font-weight:600;color:${theme.fg}">${escapeHtml(v === null ? '–' : formatPower(o.fmt, v, o.unit))}</span>` +
        `<span style="color:${theme.fg2}">${escapeHtml(e.name)}</span></div>` +
        `<div style="padding-left:18px;margin-bottom:2px;color:${theme.muted};font-size:11px;line-height:16px">${escapeHtml(detail)}</div>`
      );
    })
    .join('');
  return head + body + `<div style="margin-top:4px;color:${theme.muted};font-size:11px">${escapeHtml(o.footer)}</div>`;
}

// ---------------------------------------------------------------------------
// Peak power tiles
// ---------------------------------------------------------------------------

function BestTile({
  durationS,
  p,
  c,
  compare,
  unit,
}: {
  durationS: number;
  p: ProgressPowerEffort | undefined;
  c: ProgressPowerEffort | undefined;
  compare: ProgressPowerCompare;
  unit: PowerUnit;
}) {
  const t = useT();
  const fmt = useFormat();
  const { lang } = useI18n();
  const label = durationLabel(t, fmt, durationS);
  if (!p)
    return (
      <div className="min-w-0 rounded-control border border-border p-3">
        <Stat size="sm" label={label} value="–" hint={t('progress.power.bests.none')} />
      </div>
    );
  const v = powerValue(p, unit);
  const other = unit === 'wkg' ? formatPower(fmt, p.watts, 'w') : p.wkg !== null ? formatPower(fmt, p.wkg, 'wkg') : undefined;
  let delta: ReactNode = null;
  if (c && compare === 'allTime') {
    delta =
      p.watts >= c.watts ? (
        <Badge tone="accent" icon={Medal}>
          {t('progress.power.bests.best')}
        </Badge>
      ) : (
        <span className="text-xs text-fg-3">{t('progress.power.bests.ofBest', { pct: fmt.pct(p.watts / c.watts) })}</span>
      );
  } else if (c && compare === 'previous') {
    const pct = (p.watts - c.watts) / c.watts;
    const text = `${signedRounded(fmt, pct * 100)} %`;
    delta = <Delta value={text.startsWith('±') ? 0 : pct} text={text} />;
  }
  return (
    <Link
      to={`/activities/${p.workoutId}`}
      className="group min-w-0 rounded-control border border-border p-3 transition-colors hover:bg-surface-2"
    >
      <Stat
        size="sm"
        label={label}
        value={v === null ? '–' : unit === 'wkg' ? fmt.num(v, 1) : fmt.int(v)}
        unit={unit === 'wkg' ? 'W/kg' : 'W'}
        delta={delta}
        hint={other}
      />
      <div className="mt-1.5 truncate text-[11px] text-fg-3 group-hover:text-accent-fg">
        {workoutTitle(p, lang)} · {fmt.date(p.startTs, p.tzMin, 'dayShort')}
      </div>
    </Link>
  );
}

/** Best 5 s / 1 min / 5 min / 20 min / 1 h of the period, compared with the comparison curve. */
export function PowerBestsCard({ data, unit }: { data: ProgressPowerCurveResponse; unit: PowerUnit }) {
  const t = useT();
  const fmt = useFormat();
  const cur = new Map(data.current.points.map((p) => [p.durationS, p]));
  const cmp = new Map((data.comparison?.points ?? []).map((p) => [p.durationS, p]));
  const name = curveName(t, fmt, data.period, 'current', data.current);
  return (
    <Card className="min-w-0">
      <CardHeader
        title={t('progress.power.bests.title')}
        subtitle={`${name} · ${t('common.activities', { count: data.current.workouts })}`}
        icon={Zap}
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {KEY_DURATIONS.map((d) => (
          <BestTile key={d} durationS={d} p={cur.get(d)} c={cmp.get(d)} compare={data.compare} unit={unit} />
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Power curve chart (logarithmic duration axis)
// ---------------------------------------------------------------------------

interface ClickPoint {
  d: number;
  v: number;
  workoutId: number;
}

/** Index of the duration closest to `x` on a log scale. */
function nearestDuration(durations: number[], x: number): number | undefined {
  if (!(x > 0)) return undefined;
  let best: number | undefined;
  let bestD = Infinity;
  for (const d of durations) {
    const dist = Math.abs(Math.log(d / x));
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}

function curveOption(
  series: CurveSeries[],
  o: { theme: ChartTheme; fmt: Formatter; t: TFunction; lang: Lang; unit: PowerUnit; clickHint: string },
): { option: EChartsOption; points: ClickPoint[] } {
  const { theme, fmt, t, lang, unit } = o;
  const durations = [...new Set(series.flatMap((s) => s.curve.points.map((p) => p.durationS)))].sort((a, b) => a - b);
  const maps = series.map((s) => new Map(s.curve.points.map((p) => [p.durationS, p])));
  const maxD = Math.max(durations.at(-1) ?? 60, 2);
  const ticks = POWER_TICKS.filter((d) => d <= maxD);
  const points: ClickPoint[] = [];
  const chartSeries = series.map((s, i) => {
    // every curve has a value (or null) at every duration, so the crosshair lines both up
    const data = durations.map((d) => {
      const p = maps[i]!.get(d);
      const v = p ? powerValue(p, unit) : null;
      if (p && v !== null) points.push({ d, v, workoutId: p.workoutId });
      return [d, v];
    }) as never;
    const extra = { z: 3 - i, connectNulls: false };
    return i === 0 ? areaSeries(theme, s.name, data, s.color, extra) : lineSeries(theme, s.name, data, s.color, extra);
  });
  const option = {
    grid: grid({ top: 40, right: 18 }),
    legend: chartLegend(theme, 'line', { data: series.map((s) => s.name) }),
    xAxis: {
      type: 'log',
      logBase: 10,
      min: 1,
      max: maxD,
      axisLine: { lineStyle: { color: theme.axis, width: 1 } },
      axisTick: { show: false, customValues: ticks },
      axisLabel: {
        color: theme.muted,
        fontSize: 11,
        hideOverlap: true,
        customValues: ticks,
        formatter: (v: number) => durationLabel(t, fmt, v),
      },
      splitLine: { show: true, lineStyle: { color: theme.grid, width: 1 } },
      minorTick: { show: false },
      minorSplitLine: { show: false },
    },
    yAxis: valueAxis(theme, {
      min: 0,
      axisLabel: {
        color: theme.muted,
        fontSize: 11,
        formatter: (n: number) => (unit === 'wkg' ? fmt.num(n, Number.isInteger(n) ? 0 : 1) : fmt.int(n)),
      },
    }),
    tooltip: axisTooltip(theme, (params: unknown) => {
      const ps = (Array.isArray(params) ? params : [params]) as { seriesIndex: number; dataIndex: number; axisValue?: unknown }[];
      if (!ps.length) return '';
      const d = nearestDuration(durations, Number(ps[0]!.axisValue)) ?? durations[ps[0]!.dataIndex];
      if (d === undefined) return '';
      const entries = series.flatMap((s, i) => {
        const e = maps[i]!.get(d);
        return e ? [{ color: s.color, name: s.name, effort: e }] : [];
      });
      if (!entries.length) return '';
      return powerTipHtml(theme, durationLabel(t, fmt, d), entries, { fmt, lang, unit, footer: o.clickHint });
    }),
    series: chartSeries,
  } as EChartsOption;
  return { option, points };
}

function curveTable(series: CurveSeries[], t: TFunction, fmt: Formatter): TableView {
  const durations = [...new Set(series.flatMap((s) => s.curve.points.map((p) => p.durationS)))].sort((a, b) => a - b);
  const maps = series.map((s) => new Map(s.curve.points.map((p) => [p.durationS, p])));
  const columns: TableView['columns'] = [{ key: 'duration', label: t('progress.power.curve.duration') }];
  series.forEach((s, i) => {
    columns.push({ key: `w${i}`, label: s.name, numeric: true });
    if (s.curve.bodyMass) columns.push({ key: `kg${i}`, label: 'W/kg', numeric: true });
    columns.push({ key: `a${i}`, label: t('progress.power.curve.activity') });
  });
  const rows = durations.map((d) => {
    const row: Record<string, ReactNode> = { duration: durationLabel(t, fmt, d) };
    series.forEach((_, i) => {
      const e = maps[i]!.get(d);
      row[`w${i}`] = e ? formatPower(fmt, e.watts, 'w') : '–';
      row[`kg${i}`] = e?.wkg != null ? fmt.num(e.wkg, 2) : '–';
      row[`a${i}`] = <EffortCell e={e} />;
    });
    return row;
  });
  return { columns, rows };
}

export function PowerCurveCard({ data, unit, loading }: { data: ProgressPowerCurveResponse; unit: PowerUnit; loading: boolean }) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const { lang } = useI18n();
  const navigate = useNavigate();
  const series = useMemo(() => curveSeries(data, theme, t, fmt), [data, theme, t, fmt]);
  const any = series.some((s) => s.curve.points.length > 0);
  const built = useMemo(
    () => (any ? curveOption(series, { theme, fmt, t, lang, unit, clickHint: t('progress.power.curve.click') }) : null),
    [any, series, theme, fmt, t, lang, unit],
  );
  const table = useMemo(() => (any ? curveTable(series, t, fmt) : undefined), [any, series, t, fmt]);

  // clicks anywhere near a curve point open the activity of that effort (the points are thin lines)
  const pointsRef = useRef<ClickPoint[]>([]);
  pointsRef.current = built?.points ?? [];
  const navRef = useRef(navigate);
  navRef.current = navigate;
  const onReady = useCallback((chart: ECharts) => {
    const zr = chart.getZr();
    const nearest = (x: number, y: number): ClickPoint | null => {
      let best: ClickPoint | null = null;
      let bestDist = HIT_PX;
      for (const p of pointsRef.current) {
        const px = chart.convertToPixel({ gridIndex: 0 }, [p.d, p.v]) as number[] | undefined;
        if (!px) continue;
        const dist = Math.hypot(px[0]! - x, px[1]! - y);
        if (dist < bestDist) {
          bestDist = dist;
          best = p;
        }
      }
      return best;
    };
    zr.on('click', (e: { offsetX: number; offsetY: number }) => {
      const p = nearest(e.offsetX, e.offsetY);
      if (p) navRef.current(`/activities/${p.workoutId}`);
    });
    zr.on('mousemove', (e: { offsetX: number; offsetY: number }) => {
      zr.setCursorStyle(nearest(e.offsetX, e.offsetY) ? 'pointer' : 'default');
    });
  }, []);

  const mass = data.current.bodyMass;
  const footer = (
    <div className="grid gap-1">
      <p>{mass ? t('progress.power.curve.mass', { kg: fmt.weight(mass.kg), date: fmt.day(mass.day, 'day') }) : t('progress.power.curve.noMass')}</p>
      <p>{t('progress.power.curve.method')}</p>
    </div>
  );
  return (
    <ChartCard
      title={t('progress.power.curve.title')}
      subtitle={t(`progress.power.curve.subtitle.${unit}`)}
      icon={LineChartIcon}
      table={table}
      footer={footer}
    >
      {built ? (
        <EChart
          option={built.option}
          height={CURVE_HEIGHT}
          loading={loading}
          onReady={onReady}
          ariaLabel={`${t('progress.power.curve.title')} · ${series.map((s) => s.name).join(' · ')}`}
        />
      ) : (
        <EmptyState
          icon={LineChartIcon}
          title={t('progress.power.curve.empty')}
          description={t('progress.power.curve.emptyHint')}
          className="h-[320px]"
        />
      )}
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
// FTP estimate & critical power
// ---------------------------------------------------------------------------

/** "Use as FTP": PATCH /api/settings { ftp } — only after a click, next to the current setting. */
function UseAsFtp({ ftp }: { ftp: number }) {
  const t = useT();
  const fmt = useFormat();
  const { settings, update } = useSettings();
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | Error>('idle');
  const target = Math.round(ftp);
  const inRange = target >= 50 && target <= 600;
  const current = settings.ftp;
  const save = async () => {
    setState('saving');
    try {
      await update({ ftp: target });
      setState('saved');
    } catch (e) {
      setState(e instanceof Error ? e : new Error(String(e)));
    }
  };
  return (
    <div className="mt-4 rounded-control bg-surface-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-fg-3">
          {t('progress.power.ftp.setting')}:{' '}
          <span className="font-semibold text-fg">{current ? `${fmt.int(current)} W` : t('progress.power.ftp.notSet')}</span>
        </div>
        {current === target ? (
          <Badge tone="good" icon={CheckCircle2}>
            {t(state === 'saved' ? 'progress.power.ftp.saved' : 'progress.power.ftp.matches')}
          </Badge>
        ) : (
          <Button size="sm" variant="primary" icon={Gauge} loading={state === 'saving'} disabled={!inRange} onClick={() => void save()}>
            {t('progress.power.ftp.use', { value: `${fmt.int(target)} W` })}
          </Button>
        )}
      </div>
      {!inRange && <p className="mt-2 text-xs text-fg-3">{t('progress.power.ftp.outOfRange')}</p>}
      {state instanceof Error && <ErrorState error={state} className="mt-2" />}
    </div>
  );
}

function CriticalPowerBlock({ data }: { data: ProgressFtpResponse }) {
  const t = useT();
  const fmt = useFormat();
  const cp = data.criticalPower;
  return (
    <div className="min-w-0">
      <div className="text-xs font-semibold text-fg">{t('progress.power.cp.title')}</div>
      {cp ? (
        <>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Stat
              label={t('progress.power.cp.cp')}
              value={fmt.int(cp.cpW)}
              unit="W"
              hint={cp.cpWkg !== null ? `${fmt.num(cp.cpWkg, 2)} W/kg` : undefined}
            />
            <Stat label={t('progress.power.cp.wPrime')} value={fmt.num(cp.wPrimeJ / 1000, 1)} unit="kJ" />
          </div>
          <p className="mt-2 text-xs text-fg-3">{t('progress.power.cp.note', { count: cp.durations.length, r2: fmt.num(cp.r2, 3) })}</p>
        </>
      ) : (
        <p className="mt-1 text-sm text-fg-2">{t(`progress.power.cp.${data.criticalPowerIssue ?? 'tooFew'}`)}</p>
      )}
    </div>
  );
}

export function FtpCard({ data, error }: { data: ProgressFtpResponse | undefined; error: unknown }) {
  const t = useT();
  const fmt = useFormat();
  const { lang } = useI18n();
  const cycling = data ? isCycling(data.sport) : true;
  const src = data?.source;
  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader
        title={t(cycling ? 'progress.power.ftp.title' : 'progress.power.ftp.titleOther')}
        subtitle={t('progress.power.ftp.subtitle')}
        icon={Gauge}
      />
      {error ? (
        <ErrorState error={error} />
      ) : !data ? (
        <div className="grid gap-3">
          <Skeleton className="h-16 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : data.ftp === null || !src ? (
        <EmptyState icon={Gauge} title={t('progress.power.ftp.none')} description={t('progress.power.ftp.noneHint')} className="py-8" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
          <div className="min-w-0">
            <Stat
              size="lg"
              label={t(`progress.power.ftp.window.${data.windowDays}`)}
              value={fmt.int(data.ftp)}
              unit="W"
              hint={data.ftpWkg !== null ? `${fmt.num(data.ftpWkg, 2)} W/kg` : undefined}
            />
            <Link
              to={`/activities/${src.workoutId}`}
              className="mt-2 block text-xs text-fg-3 hover:text-accent-fg hover:underline"
            >
              {t('progress.power.ftp.basis', { watts: formatPower(fmt, src.watts, 'w') })} · {workoutTitle(src, lang)} ·{' '}
              {fmt.date(src.startTs, src.tzMin, 'day')}
            </Link>
            {data.windowDays === 90 && <p className="mt-1 text-xs text-fg-3">{t('progress.power.ftp.fallback')}</p>}
            {cycling ? (
              <UseAsFtp ftp={data.ftp} />
            ) : (
              <p className="mt-3 text-xs text-fg-3">{t('progress.power.ftp.cyclingOnly', { sport: sportLabel(data.sport, lang) })}</p>
            )}
          </div>
          <div className="min-w-0 border-t border-border pt-4 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0 xl:border-l-0 xl:border-t xl:pl-0 xl:pt-4">
            <CriticalPowerBlock data={data} />
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// FTP estimate per month / quarter
// ---------------------------------------------------------------------------

function historyOption(
  data: ProgressFtpResponse,
  o: { theme: ChartTheme; fmt: Formatter; t: TFunction; lang: Lang; setting: number | null; name: string },
): EChartsOption {
  const { theme, fmt, t, lang } = o;
  const pts = data.history.points;
  const labels = pts.map((p) => historyBucketLabel(t, fmt, p.key));
  const values = pts.map((p) => p.ftp);
  const shown = values.filter((v): v is number => v !== null);
  if (o.setting) shown.push(o.setting);
  const lo = Math.min(...shown);
  const hi = Math.max(...shown);
  const pad = Math.max(10, (hi - lo) * 0.15);
  const color = theme.series[0]!;
  return {
    grid: grid({ top: 24, right: 18 }),
    xAxis: categoryAxis(theme, labels),
    yAxis: valueAxis(theme, {
      min: Math.max(0, Math.floor((lo - pad) / 10) * 10),
      max: Math.ceil((hi + pad) / 10) * 10,
      axisLabel: { color: theme.muted, fontSize: 11, formatter: (n: number) => fmt.int(n) },
    }),
    tooltip: axisTooltip(theme, (params: unknown) => {
      const ps = (Array.isArray(params) ? params : [params]) as { dataIndex: number }[];
      const i = ps[0]?.dataIndex;
      if (i === undefined || !pts[i]) return '';
      const p = pts[i]!;
      const head = `<div style="color:${theme.muted};font-size:11px;margin-bottom:4px">${escapeHtml(labels[i]!)}</div>`;
      if (p.ftp === null || !p.source) return `${head}<div style="color:${theme.fg2}">${escapeHtml(t('progress.power.history.noEffort'))}</div>`;
      const s = p.source;
      const main =
        `<div style="display:flex;align-items:center;gap:8px;line-height:18px">` +
        `<span style="display:inline-block;width:10px;height:2px;border-radius:1px;background:${color}"></span>` +
        `<span style="font-weight:600;color:${theme.fg}">${escapeHtml(formatPower(fmt, p.ftp, 'w'))}</span>` +
        `<span style="color:${theme.fg2}">${escapeHtml(t('progress.power.history.estimate'))}` +
        `${p.ftpWkg !== null ? ` · ${escapeHtml(formatPower(fmt, p.ftpWkg, 'wkg', 2))}` : ''}</span></div>`;
      const detail = `${t('progress.power.history.best20')}: ${formatPower(fmt, s.watts, 'w')} · ${workoutTitle(s, lang)} · ${fmt.date(s.startTs, s.tzMin, 'day')}`;
      return (
        head +
        main +
        `<div style="padding-left:18px;color:${theme.muted};font-size:11px;line-height:16px">${escapeHtml(detail)}</div>` +
        `<div style="margin-top:4px;color:${theme.muted};font-size:11px">${escapeHtml(t('progress.power.curve.click'))}</div>`
      );
    }),
    series: [
      lineSeries(theme, o.name, values, color, {
        showSymbol: true,
        symbolSize: 7,
        connectNulls: false,
        ...(o.setting
          ? {
              markLine: {
                silent: true,
                symbol: 'none',
                animation: false,
                lineStyle: { color: theme.fg2, width: 1, type: [4, 4] },
                label: {
                  show: true,
                  position: 'insideEndTop',
                  color: theme.fg2,
                  fontSize: 11,
                  formatter: t('progress.power.history.setting', { value: formatPower(fmt, o.setting, 'w') }),
                },
                data: [{ yAxis: o.setting }],
              },
            }
          : {}),
      }),
      hitLayer(
        'hit',
        pts.flatMap((p, i) => (p.ftp === null ? [] : [{ value: [i, p.ftp], idx: i }])),
      ),
    ],
  } as EChartsOption;
}

export function FtpHistoryCard({ data, loading, error }: { data: ProgressFtpResponse | undefined; loading: boolean; error: unknown }) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const { lang } = useI18n();
  const navigate = useNavigate();
  const { settings } = useSettings();
  const cycling = data ? isCycling(data.sport) : true;
  const setting = cycling ? settings.ftp : null;
  const title = t(cycling ? 'progress.power.history.title' : 'progress.power.history.titleOther');
  const pts = data?.history.points;
  const any = !!pts?.some((p) => p.ftp !== null);
  const option = useMemo(
    () => (data && any ? historyOption(data, { theme, fmt, t, lang, setting, name: t('progress.power.history.estimate') }) : null),
    [data, any, theme, fmt, t, lang, setting],
  );
  const onEvents = useMemo(
    () => ({
      click: (p: { data?: { idx?: number } }) => {
        const i = p.data?.idx;
        const s = i !== undefined ? pts?.[i]?.source : null;
        if (s) navigate(`/activities/${s.workoutId}`);
      },
    }),
    [pts, navigate],
  );
  const table = useMemo((): TableView | undefined => {
    if (!data || !any) return undefined;
    return {
      columns: [
        { key: 'bucket', label: t(data.history.bucket === 'quarter' ? 'progress.power.history.quarter' : 'progress.power.history.month') },
        { key: 'ftp', label: t('progress.power.history.estimate'), numeric: true },
        { key: 'wkg', label: 'W/kg', numeric: true },
        { key: 'best', label: t('progress.power.history.best20'), numeric: true },
        { key: 'activity', label: t('progress.power.curve.activity') },
      ],
      rows: [...data.history.points].reverse().map((p) => ({
        bucket: historyBucketLabel(t, fmt, p.key),
        ftp: p.ftp !== null ? formatPower(fmt, p.ftp, 'w') : '–',
        wkg: p.ftpWkg !== null ? fmt.num(p.ftpWkg, 2) : '–',
        best: p.source ? formatPower(fmt, p.source.watts, 'w') : '–',
        activity: <EffortCell e={p.source ?? undefined} />,
      })),
    };
  }, [data, any, t, fmt]);
  return (
    <ChartCard
      title={title}
      subtitle={data ? t(`progress.power.history.subtitle.${data.history.bucket}`) : undefined}
      icon={TrendingUp}
      table={table}
    >
      {error ? (
        <ErrorState error={error} />
      ) : !data ? (
        <ChartSkeleton height={HISTORY_HEIGHT} />
      ) : !option ? (
        <EmptyState icon={TrendingUp} title={t('progress.power.history.empty')} className="h-[260px]" />
      ) : (
        <EChart option={option} height={HISTORY_HEIGHT} loading={loading} onEvents={onEvents} ariaLabel={title} />
      )}
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
// No power data at all
// ---------------------------------------------------------------------------

export function NoPowerCard() {
  const t = useT();
  return (
    <Card>
      <EmptyState icon={Zap} title={t('progress.power.empty.title')} description={t('progress.power.empty.hint')} />
    </Card>
  );
}
