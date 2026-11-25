import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { GitCompareArrows, Route, Trophy } from 'lucide-react';
import { workoutTitle, type ActivitySimilar, type ActivitySimilarItem, type WorkoutDetail } from '@cadence/shared';
import { ChartCard, type TableView } from '@/components/charts/ChartCard';
import { EChart, type EChartsOption } from '@/components/charts/EChart';
import { useChartTheme } from '@/components/charts/theme';
import { Badge, Delta, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { clock, useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { sportLabel } from '@/lib/sports';
import { isPaceSport, paceValue } from '../../lib/display';
import { linearTrend, trendChart, type Pt } from '../../lib/similar';
import { ToggleChip } from '../ToggleChip';

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
  const speedValue = (x: ActivitySimilarItem) => (x.avgSpeed ? paceValue(x.avgSpeed, w.sport, fmt.units) : null);
  const names = { others: t('activities.similar.others'), current: t('activities.similar.thisActivity'), trend: t('activities.similar.trend') };
  // the activity's own local day (as in the table), not the UTC one
  const dateLabel = (ms: number, tzMin: number) => fmt.date(ms / 1000, tzMin, 'day');
  const pts = (value: (x: ActivitySimilarItem) => number | null): Pt[] =>
    items.flatMap((x) => {
      const y = value(x);
      return y === null ? [] : [{ id: x.id, x: x.startTs * 1000, y, current: x.current, title: workoutTitle(x, lang), tzMin: x.tzMin }];
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
      { key: 'compare', label: t('activities.similar.compare') },
    ],
    rows: [...items].reverse().map((x) => ({
      compare: x.current ? null : (
        <Link
          to={`/activities/${w.id}/compare/${x.id}`}
          title={t('activities.similar.compareWith', { title: workoutTitle(x, lang) })}
          className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-accent-fg hover:underline"
        >
          <GitCompareArrows size={13} aria-hidden />
          {t('activities.similar.compare')}
        </Link>
      ),
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
