/**
 * Widgets of the "maps" feature: `ExplorerWidget` on the dashboard (registered in ./index.tsx) and
 * `WorkoutMapsCard` on the activity page (placed by the activities feature).
 * Each widget renders its own <Card> and fetches its own data; return null when there is nothing to show.
 */
import { Link } from 'react-router';
import { ArrowRight, Grid3x3, Route as RouteIcon, Star, Trophy } from 'lucide-react';
import type { MapsExplorerSummary, MapsWorkoutLinks } from '@cadence/shared';
import { Badge, Card, CardHeader, Delta, ErrorState, Skeleton, Stat, Table, TD, TH } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useI18n, useT } from '@/lib/i18n';
import { countVars } from './lib/counts';
import { speedLabelKey } from './lib/effortSort';
import { routeTitle } from './lib/routeName';

/** Explorer tiles at a glance: visited tiles, max square and the tiles that are new this month. */
export function ExplorerWidget() {
  const t = useT();
  const fmt = useFormat();
  const q = useApi<MapsExplorerSummary>(['maps', 'explorer-summary'], '/maps/explorer/summary');

  if (q.isError) {
    return (
      <Card>
        <CardHeader icon={Grid3x3} title={t('maps.widget.title')} />
        <ErrorState error={q.error} />
      </Card>
    );
  }
  if (!q.data) {
    // same height as the loaded card so the dashboard does not jump
    return (
      <Card>
        <CardHeader icon={Grid3x3} title={t('maps.widget.title')} />
        <Skeleton className="h-[4.25rem] w-full" />
      </Card>
    );
  }
  const d = q.data;
  if (d.tiles === 0) return null;
  const change = d.newThisMonth - d.newLastMonth;
  return (
    <Card className="@container">
      <CardHeader
        icon={Grid3x3}
        title={t('maps.widget.title')}
        actions={
          <Link
            to="/maps/explorer"
            className="inline-flex items-center gap-1 rounded-control px-2 py-1 text-xs font-medium text-accent-fg hover:bg-accent-soft"
          >
            {t('maps.widget.open')}
            <ArrowRight size={13} aria-hidden />
          </Link>
        }
      />
      <div className="grid grid-cols-2 gap-4 @sm:grid-cols-3">
        <Stat label={t('maps.explorer.stats.tiles')} value={fmt.int(d.tiles)} size="md" />
        <Stat
          label={t('maps.explorer.stats.maxSquare')}
          value={d.maxSquare ? `${d.maxSquare} × ${d.maxSquare}` : '–'}
          hint={d.maxSquare ? t('maps.explorer.stats.maxSquareHint', countVars(fmt, d.maxSquare ** 2)) : undefined}
          size="md"
        />
        <Stat
          label={t('maps.widget.newThisMonth')}
          value={fmt.int(d.newThisMonth)}
          delta={change !== 0 ? <Delta value={change} text={fmt.signed(change)} /> : undefined}
          hint={t('maps.explorer.stats.vsLastMonth')}
          size="md"
        />
      </div>
      <p className="mt-3 text-xs text-fg-3">{t('maps.widget.subtitle')}</p>
    </Card>
  );
}

/**
 * Route and segment efforts of one activity (GET /api/maps/workouts/:id): the recurring route it belongs to with
 * this activity's rank there, and every segment it crossed with time, pace, heart rate and rank (PR medal).
 */
export function WorkoutMapsCard({ workoutId, sport }: { workoutId: number; sport: string }) {
  const t = useT();
  const fmt = useFormat();
  const { lang } = useI18n();
  const q = useApi<MapsWorkoutLinks>(['maps', 'workout', workoutId], `/maps/workouts/${workoutId}`);
  const d = q.data;
  // nothing to show (yet): render nothing rather than an empty card
  if (!d || (!d.route && d.segments.length === 0)) return null;
  const r = d.route;
  return (
    <Card className="min-w-0">
      <CardHeader
        icon={RouteIcon}
        title={t('maps.workoutCard.title')}
        subtitle={t('maps.workoutCard.subtitle')}
        actions={
          <Link
            to={`/maps/segments/new?workout=${workoutId}`}
            className="inline-flex items-center gap-1 rounded-control px-2 py-1 text-xs font-medium text-accent-fg hover:bg-accent-soft"
          >
            {t('maps.workoutCard.createSegment')}
            <ArrowRight size={13} aria-hidden />
          </Link>
        }
      />
      {r && (
        <Link
          to={`/maps/routes/${r.id}`}
          className="-mx-2 mb-3 flex min-w-0 items-center justify-between gap-3 rounded-control px-2 py-2 hover:bg-surface-2"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-fg">
              {routeTitle({ ...r, startLat: null, startLon: null }, t, fmt, lang)}
            </span>
            <span className="block text-xs text-fg-3">
              {t('maps.workoutCard.routeDone', countVars(fmt, r.count))} · {t('maps.workoutCard.best', { time: fmt.duration(r.bestTimeS) })}
            </span>
          </span>
          {r.rank !== null && r.count > 1 && (
            <Badge tone={r.rank === 1 ? 'accent' : 'neutral'} icon={r.rank === 1 ? Trophy : undefined}>
              {r.rank === 1 ? t('maps.workoutCard.routeBest') : t('maps.workoutCard.rank', { rank: fmt.int(r.rank), count: fmt.int(r.count) })}
            </Badge>
          )}
        </Link>
      )}
      {d.segments.length > 0 && (
        <Table>
          <thead>
            <tr>
              <TH>{t('maps.workoutCard.segment')}</TH>
              <TH numeric>{t('maps.workoutCard.time')}</TH>
              <TH numeric>{t(speedLabelKey(sport))}</TH>
              <TH numeric>{t('maps.workoutCard.hr')}</TH>
              <TH numeric>{t('maps.workoutCard.rankCol')}</TH>
            </tr>
          </thead>
          <tbody>
            {d.segments.map((e) => (
              <tr key={`${e.segmentId}-${e.idx}`}>
                <TD>
                  <Link
                    to={`/maps/segments/${e.segmentId}`}
                    className="inline-flex min-w-0 items-center gap-1.5 font-medium text-fg hover:text-accent-fg hover:underline"
                  >
                    {e.starred && <Star size={13} className="shrink-0 fill-current text-fg-3" aria-label={t('maps.workoutCard.starred')} />}
                    <span className="truncate">{e.name}</span>
                  </Link>
                  <span className="block text-xs text-fg-3">{fmt.distance(e.distanceM)}</span>
                </TD>
                <TD numeric>{fmt.duration(e.elapsedS)}</TD>
                <TD numeric>{fmt.pace(e.avgSpeed, sport)}</TD>
                <TD numeric>{e.avgHr ? fmt.hr(e.avgHr) : '–'}</TD>
                <TD numeric>
                  {e.pr ? (
                    <Badge tone="accent" icon={Trophy}>
                      {t('maps.workoutCard.pr')}
                    </Badge>
                  ) : (
                    t('maps.workoutCard.rank', { rank: fmt.int(e.rank), count: fmt.int(e.efforts) })
                  )}
                </TD>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
