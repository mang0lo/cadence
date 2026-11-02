import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { GitCompareArrows, Route, Trophy } from 'lucide-react';
import { M_PER_KM, M_PER_MI, workoutTitle, type ActivitySimilar, type ActivitySimilarItem, type WorkoutDetail } from '@cadence/shared';
import { ChartCard, type TableView } from '@/components/charts/ChartCard';
import { EChart, type EChartsOption } from '@/components/charts/EChart';
import { itemTooltip, legend, lineSeries, scatterSeries, timeAxis, tooltipHtml, valueAxis } from '@/components/charts/options';
import { useChartTheme, type ChartTheme } from '@/components/charts/theme';
import { Badge, Delta, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { clock, useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { sportLabel } from '@/lib/sports';
import { isPaceSport } from '../../lib/display';
import { ToggleChip } from '../ToggleChip';

interface Pt {
  id: number;
  x: number; // ms
  y: number;
  current: boolean;
  title: string;
}

/** Least squares line through (x, y); null with fewer than 3 points or no spread in x. */
export function linearTrend(pts: { x: number; y: number }[]): { slope: number; intercept: number } | null {
  if (pts.length < 3) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

function trendChart(
  pts: Pt[],
  theme: ChartTheme,
  o: {
    inverse: boolean;
    format: (v: number) => string;
    names: { others: string; current: string; trend: string };
    dateLabel: (ms: number) => string;
    minInterval?: number;
  },
): EChartsOption {
  const others = pts.filter((p) => !p.current);
  const cur = pts.find((p) => p.current);
  const tr = linearTrend(pts);
  const xs = pts.map((p) => p.x);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const tooltip = itemTooltip(theme, (raw: unknown) => {
    const p = raw as { data: [number, number, number, string]; seriesName: string; color: string };
    if (p.seriesName === o.names.trend) return tooltipHtml(o.names.trend, [{ color: theme.muted, value: o.format(p.data[1]), label: o.dateLabel(p.data[0]) }], theme);
    return tooltipHtml(o.dateLabel(p.data[0]), [{ color: p.color, value: o.format(p.data[1]), label: p.data[3] }], theme);
  });
  return {
    grid: { left: 4, right: 12, top: 34, bottom: 4, containLabel: true },
    legend: legend(theme, 'rect', { data: [o.names.current, o.names.others, o.names.trend] }),
    tooltip,
    xAxis: timeAxis(theme),
    yAxis: valueAxis(theme, {
      inverse: o.inverse,
      scale: true,
      minInterval: o.minInterval,
      axisLabel: { color: theme.muted, fontSize: 11, formatter: o.format },
    }),
    series: [
      scatterSeries(theme, o.names.others, others.map((p) => [p.x, p.y, p.id, p.title]), theme.other, { symbolSize: 8 }),
      ...(tr && x1 > x0
        ? [
            lineSeries(
              theme,
              o.names.trend,
              [
                [x0, tr.intercept + tr.slope * x0],
                [x1, tr.intercept + tr.slope * x1],
              ],
              theme.muted,
              { lineStyle: { width: 1.5, color: theme.muted }, silent: false, z: 1 },
            ),
          ]
        : []),
      ...(cur
        ? [
            scatterSeries(theme, o.names.current, [[cur.x, cur.y, cur.id, cur.title]], theme.accent, {
              symbolSize: 14,
              z: 5,
              label: { show: true, position: 'left', distance: 8, formatter: o.names.current, color: theme.fg, fontSize: 11, fontWeight: 600 },
            }),
          ]
        : []),
    ],
  };
}

/** Pace (or effort) and heart rate of similar activities over time, this one highlighted with its rank. */
export function Similar({
  w,
  similar,
  loading,
  error,
}: {
  w: WorkoutDetail;
  similar: ActivitySimilar | undefined;
  loading: boolean;
  error: unknown;
}) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const theme = useChartTheme();
  const navigate = useNavigate();
  const [routeOnly, setRouteOnly] = useState(false);
  const pace = isPaceSport(w.sport);
  const byDistance = similar?.basis === 'distance';
  const items = useMemo(
    () => (similar?.items ?? []).filter((x) => !routeOnly || x.sameRoute),
    [similar, routeOnly],
  );
  const imperial = fmt.units === 'imperial';
  const unitM = w.sport === 'swim' ? (imperial ? 91.44 : 100) : imperial ? M_PER_MI : M_PER_KM;
  const speedValue = (x: ActivitySimilarItem) =>
    x.avgSpeed ? (pace ? unitM / x.avgSpeed : imperial ? x.avgSpeed / (M_PER_MI / 3600) : x.avgSpeed * 3.6) : null;
  const names = { others: t('activities.similar.others'), current: t('activities.similar.thisActivity'), trend: t('activities.similar.trend') };
  const dateLabel = (ms: number) => fmt.date(ms / 1000, 0, 'day');
  const pts = (value: (x: ActivitySimilarItem) => number | null): Pt[] =>
    items.flatMap((x) => {
      const y = value(x);
      return y === null ? [] : [{ id: x.id, x: x.startTs * 1000, y, current: x.current, title: workoutTitle(x, lang) }];
    });

  const charts = useMemo(() => {
    if (!similar || items.length < 2) return [];
    const out: { key: string; title: string; option: EChartsOption }[] = [];
    if (byDistance) {
      out.push({
        key: 'pace',
        title: pace ? t('activities.similar.paceChart') : t('activities.similar.speedChart'),
        option: trendChart(pts(speedValue), theme, {
          inverse: pace,
          format: (v) => (pace ? clock(v) : fmt.num(v, 1)),
          names,
          dateLabel,
        }),
      });
    } else {
      out.push({
        key: 'effort',
        title: t('common.effort'),
        option: trendChart(pts((x) => x.effort), theme, { inverse: false, format: (v) => fmt.int(v), names, dateLabel, minInterval: 1 }),
      });
    }
    const hr = pts((x) => x.avgHr);
    if (hr.length >= 2)
      out.push({
        key: 'hr',
        title: t('activities.similar.hrChart'),
        option: trendChart(hr, theme, { inverse: false, format: (v) => fmt.int(v), names, dateLabel, minInterval: 1 }),
      });
    const ef = pts((x) => x.efficiency);
    if (ef.length >= 3)
      out.push({
        key: 'ef',
        title: t('activities.similar.efChart'),
        option: trendChart(ef, theme, { inverse: false, format: (v) => fmt.num(v, 2), names, dateLabel }),
      });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [similar, items, byDistance, pace, theme, fmt, t, lang]);

  // improvement sentence: pace change per year from the trend (distance basis, ≥ 5 activities over ≥ 60 days)
  const trendText = useMemo(() => {
    if (!byDistance) return null;
    const p = pts(speedValue);
    if (p.length < 5) return null;
    const span = (Math.max(...p.map((x) => x.x)) - Math.min(...p.map((x) => x.x))) / 86_400_000;
    if (span < 60) return null;
    const tr = linearTrend(p);
    if (!tr) return null;
    const perYear = tr.slope * 365 * 86_400_000;
    const better = pace ? perYear < 0 : perYear > 0;
    const value = pace ? `${perYear < 0 ? '−' : '+'}${clock(Math.abs(perYear))} ${fmt.paceParts(1, w.sport).unit}` : `${fmt.signed(perYear, 1)} ${fmt.speedParts(1).unit}`;
    if (Math.abs(perYear) < (pace ? 1 : 0.1)) return null;
    return { perYear, text: t(better ? 'activities.similar.improving' : 'activities.similar.slowing', { value }) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, byDistance, pace, fmt, t]);

  const table: TableView = {
    columns: [
      { key: 'date', label: t('activities.similar.date') },
      { key: 'title', label: t('activities.detail.titleLabel') },
      { key: 'distance', label: t('common.distance'), numeric: true },
      { key: 'time', label: t('activities.stats.moving'), numeric: true },
      { key: 'pace', label: pace ? t('common.pace') : t('common.speed'), numeric: true },
      { key: 'hr', label: t('common.avgHr'), numeric: true },
      { key: 'effort', label: t('common.effort'), numeric: true },
    ],
    rows: [...items].reverse().map((x) => ({
      date: fmt.date(x.startTs, x.tzMin, 'day'),
      title: x.current ? <strong>{workoutTitle(x, lang)}</strong> : workoutTitle(x, lang),
      distance: x.distanceM ? fmt.distance(x.distanceM) : '–',
      time: fmt.duration(x.movingS ?? x.durationS),
      pace: x.avgSpeed ? fmt.pace(x.avgSpeed, x.sport) : '–',
      hr: x.avgHr ? fmt.int(x.avgHr) : '–',
      effort: x.effort !== null ? fmt.int(x.effort) : '–',
    })),
  };

  const rangeText = similar
    ? t(byDistance ? 'activities.similar.subtitleDistance' : 'activities.similar.subtitleDuration', {
        sport: sportLabel(w.sport, lang),
        min: byDistance ? fmt.distance(similar.min, 1) : fmt.durationShort(similar.min),
        max: byDistance ? fmt.distance(similar.max, 1) : fmt.durationShort(similar.max),
      })
    : undefined;
  const rankKey = byDistance ? (pace ? 'activities.similar.rank' : 'activities.similar.rankSpeed') : 'activities.similar.rankEffort';

  return (
    <ChartCard
      title={t('activities.similar.title')}
      subtitle={rangeText}
      icon={GitCompareArrows}
      table={similar && items.length >= 2 ? table : undefined}
      actions={
        similar && similar.routeCount >= 3 ? (
          <ToggleChip size="sm" active={routeOnly} onChange={setRouteOnly} icon={Route}>
            {t('activities.similar.sameRoute')}
          </ToggleChip>
        ) : undefined
      }
    >
      {error ? (
        <ErrorState error={error} />
      ) : loading || !similar ? (
        <Skeleton className="h-64 w-full" />
      ) : items.length < 2 ? (
        <EmptyState icon={GitCompareArrows} title={t('activities.similar.none')} />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            {similar.rank !== null && (
              <Badge tone={similar.rank <= 3 ? 'accent' : 'neutral'} icon={Trophy}>
                {t(rankKey, { rank: similar.rank, count: similar.count })}
              </Badge>
            )}
            {similar.routeRank !== null && similar.routeCount >= 2 && (
              <Badge icon={Route}>{t('activities.similar.routeRank', { rank: similar.routeRank, count: similar.routeCount })}</Badge>
            )}
            {trendText && <Delta value={trendText.perYear} upIsGood={!pace} text={trendText.text} />}
          </div>
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {charts.map((c) => (
              <div key={c.key} className="min-w-0">
                <h3 className="mb-1 text-xs font-medium text-fg-2">{c.title}</h3>
                <EChart
                  option={c.option}
                  height={240}
                  ariaLabel={c.title}
                  onEvents={{
                    click: (p: { data?: unknown[] }) => {
                      const id = p.data?.[2];
                      if (typeof id === 'number' && id !== w.id) navigate(`/activities/${id}`);
                    },
                  }}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </ChartCard>
  );
}
