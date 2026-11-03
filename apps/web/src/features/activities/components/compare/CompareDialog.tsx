import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Route as RouteIcon, Search, Trophy } from 'lucide-react';
import { workoutTitle, type WorkoutSummary } from '@cadence/shared';
import { Badge, Dialog, EmptyState, ErrorState, Input, Skeleton } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { sportLabel } from '@/lib/sports';
import { routeTitle } from '../../../maps/lib/routeName';
import { useRouteDetail, useRouteLinks, useSimilar, useSportActivities } from '../../api';

interface Candidate {
  id: number;
  name: string;
  sport: string;
  startTs: number;
  tzMin: number;
  distanceM: number | null;
  timeS: number;
  avgSpeed: number | null;
  badge?: ReactNode;
}

function Row({ from, c }: { from: number; c: Candidate }) {
  const { lang } = useI18n();
  const fmt = useFormat();
  return (
    <li>
      <Link
        to={`/activities/${from}/compare/${c.id}`}
        className="flex min-w-0 items-center justify-between gap-3 rounded-control px-2 py-2 hover:bg-surface-2"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-fg">{workoutTitle(c, lang)}</span>
          <span className="block truncate text-xs text-fg-3">{fmt.date(c.startTs, c.tzMin, 'dateTime')}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs tabular text-fg-2">
          {c.badge}
          <span className="text-right">
            <span className="block">{c.distanceM ? fmt.distance(c.distanceM) : fmt.duration(c.timeS)}</span>
            <span className="block text-fg-3">
              {c.distanceM ? `${fmt.duration(c.timeS)} · ${fmt.pace(c.avgSpeed, c.sport)}` : ''}
            </span>
          </span>
        </span>
      </Link>
    </li>
  );
}

function Section({ title, icon, children }: { title: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid gap-1">
      <h3 className="flex items-center gap-1.5 px-2 text-xs font-medium text-fg-3">
        {icon}
        {title}
      </h3>
      <ul className="grid">{children}</ul>
    </section>
  );
}

/**
 * Picks the activity to compare `w` with: other efforts on the same recurring route first, then similar activities,
 * plus a search over the same sport. Choosing one opens /activities/:id/compare/:otherId. Mount it while open only (it
 * fetches its suggestions on mount).
 */
export function CompareDialog({ w, onClose }: { w: Pick<WorkoutSummary, 'id' | 'sport' | 'hasRoute'>; onClose: () => void }) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(id);
  }, [q]);

  const links = useRouteLinks(w.id, w.hasRoute);
  const route = links.data?.route ?? null;
  const routeDetail = useRouteDetail(route && route.count > 1 ? route.id : null);
  const similar = useSimilar(w.id);
  const searching = debounced.length > 0;
  const list = useSportActivities(w.sport, debounced);

  const sections = useMemo(() => {
    const seen = new Set<number>([w.id]);
    const take = (items: Candidate[], max: number) => {
      const out: Candidate[] = [];
      for (const c of items) {
        if (seen.has(c.id) || out.length >= max) continue;
        seen.add(c.id);
        out.push(c);
      }
      return out;
    };
    const onRoute = take(
      (routeDetail.data?.efforts ?? []).map((e) => ({
        id: e.workoutId,
        name: e.name,
        sport: e.sport,
        startTs: e.startTs,
        tzMin: e.tzMin,
        distanceM: e.distanceM,
        timeS: e.timeS,
        avgSpeed: e.avgSpeed,
        badge:
          e.rank === 1 ? (
            <Badge tone="accent" icon={Trophy}>
              {t('activities.compare.fastest')}
            </Badge>
          ) : (
            <Badge>{t('activities.compare.rank', { rank: e.rank })}</Badge>
          ),
      })),
      12,
    );
    const alike = take(
      [...(similar.data?.items ?? [])].reverse().map((x) => ({
        id: x.id,
        name: x.name,
        sport: x.sport,
        startTs: x.startTs,
        tzMin: x.tzMin,
        distanceM: x.distanceM,
        timeS: x.movingS ?? x.durationS,
        avgSpeed: x.avgSpeed,
        badge: x.sameRoute ? <RouteIcon size={14} className="text-fg-3" aria-label={t('activities.compare.sameRoute')} /> : undefined,
      })),
      10,
    );
    const recent = take(
      (list.data?.items ?? []).map((x) => ({
        id: x.id,
        name: x.name,
        sport: x.sport,
        startTs: x.startTs,
        tzMin: x.tzMin,
        distanceM: x.distanceM,
        timeS: x.movingS ?? x.durationS,
        avgSpeed: x.avgSpeed,
      })),
      searching ? 20 : 8,
    );
    return { onRoute, alike, recent };
  }, [w.id, routeDetail.data, similar.data, list.data, searching, t]);

  const sport = sportLabel(w.sport, lang);
  const results = searching ? sections.recent : [...sections.onRoute, ...sections.alike, ...sections.recent];
  const loading =
    !results.length &&
    (list.isLoading || (!searching && (similar.isLoading || links.isLoading || routeDetail.isLoading)));
  const error = results.length ? null : (list.error ?? (searching ? null : similar.error));

  return (
    <Dialog open onClose={onClose} title={t('activities.compare.dialogTitle')}>
      <div className="grid gap-3">
        <label className="relative block">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" aria-hidden />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('activities.compare.search', { sport })}
            aria-label={t('activities.compare.search', { sport })}
            className="pl-9"
          />
        </label>
        <div className="-mx-2 grid max-h-[min(60vh,480px)] gap-3 overflow-y-auto scrollbar-thin">
          {error ? (
            <ErrorState error={error} className="mx-2" />
          ) : loading ? (
            <div className="grid gap-2 px-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-11 w-full" />
              ))}
            </div>
          ) : !results.length ? (
            <EmptyState
              icon={Search}
              title={searching ? t('activities.compare.noResults') : t('activities.compare.none', { sport })}
              className="py-8"
            />
          ) : searching ? (
            <Section title={t('activities.compare.results')}>
              {sections.recent.map((c) => (
                <Row key={c.id} from={w.id} c={c} />
              ))}
            </Section>
          ) : (
            <>
              {sections.onRoute.length > 0 && route && (
                <Section
                  title={`${t('activities.compare.sameRoute')} · ${routeTitle({ ...route, startLat: null, startLon: null }, t, fmt, lang)}`}
                  icon={<RouteIcon size={13} aria-hidden />}
                >
                  {sections.onRoute.map((c) => (
                    <Row key={c.id} from={w.id} c={c} />
                  ))}
                </Section>
              )}
              {sections.alike.length > 0 && (
                <Section title={t('activities.compare.similar')}>
                  {sections.alike.map((c) => (
                    <Row key={c.id} from={w.id} c={c} />
                  ))}
                </Section>
              )}
              {sections.recent.length > 0 && (
                <Section title={t('activities.compare.recent', { sport })}>
                  {sections.recent.map((c) => (
                    <Row key={c.id} from={w.id} c={c} />
                  ))}
                </Section>
              )}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
