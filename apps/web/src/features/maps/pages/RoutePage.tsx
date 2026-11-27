import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Pencil, Route as RouteIcon, Trophy, X } from 'lucide-react';
import { workoutTitle, type MapsRouteDetail, type MapsRouteEffort } from '@cadence/shared';
import { useChartTheme } from '@/components/charts/theme';
import {
  Button,
  Card,
  CardHeader,
  Delta,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  Page,
  PageHeader,
  Skeleton,
  Stat,
  StatRow,
} from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { speedLabelKey, useFormat } from '@/lib/format';
import { useI18n, useT } from '@/lib/i18n';
import { SportBadge } from '@/lib/sports';
import { decodePolyline, toLngLat } from '@/lib/polyline';
import { EffortTable, type EffortRow } from '../components/EffortTable';
import { EffortTrend } from '../components/EffortTrend';
import { LineMap, useShownOverlayColors, type MapLine } from '../components/LineMap';
import { unionBox, type BBox } from '../lib/home';
import { kindLabel, routeTitle } from '../lib/routeName';

/** +1:37 / −0:12 */
const signedDuration = (fmt: { duration: (s: number) => string }, s: number): string =>
  `${s > 0 ? '+' : s < 0 ? '−' : '±'}${fmt.duration(Math.abs(s))}`;

export default function RoutePage() {
  const t = useT();
  const { id } = useParams();
  const q = useApi<MapsRouteDetail>(['maps', 'route', id], id ? `/maps/routes/${id}` : null);
  const d = q.data;

  return (
    <Page wide>
      <div className="mb-3">
        <Link to="/maps/routes">
          <Button variant="ghost" size="sm" icon={ArrowLeft}>
            {t('maps.titles.RoutesPage')}
          </Button>
        </Link>
      </div>
      {q.isError && <ErrorState error={q.error} />}
      {!d && !q.isError && <RouteSkeleton />}
      {d && <RouteBody detail={d} key={d.route.id} />}
      {d === undefined && q.isError && (
        <Card className="mt-4">
          <EmptyState icon={RouteIcon} title={t('maps.routes.notFound')} />
        </Card>
      )}
    </Page>
  );
}

function RouteSkeleton() {
  return (
    <div className="grid gap-4">
      <Skeleton className="h-10 w-80" />
      <Skeleton className="h-28 w-full rounded-card" />
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-96 rounded-card" />
        <Skeleton className="h-96 rounded-card" />
      </div>
    </div>
  );
}

function RouteBody({ detail }: { detail: MapsRouteDetail }) {
  const t = useT();
  const fmt = useFormat();
  const { lang } = useI18n();
  const { route, efforts } = detail;
  const qc = useQueryClient();
  const title = routeTitle(route, t, fmt, lang);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const rename = async (name: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/maps/routes/${route.id}`, { name });
      await qc.invalidateQueries({ queryKey: ['maps'] });
      setEditing(false);
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  const best = efforts.find((e) => e.workoutId === route.bestWorkoutId) ?? efforts[efforts.length - 1];
  const latest = efforts[0];
  const first = efforts[efforts.length - 1];
  const improvement = first && best && first.timeS > 0 ? (first.timeS - best.timeS) / first.timeS : null;
  const rows = useMemo<EffortRow[]>(
    () =>
      efforts.map((e) => ({
        key: String(e.workoutId),
        workoutId: e.workoutId,
        name: e.name,
        sport: e.sport,
        startTs: e.startTs,
        tzMin: e.tzMin,
        timeS: e.timeS,
        avgSpeed: e.avgSpeed,
        avgHr: e.avgHr,
        rank: e.rank,
        best: e.rank === 1,
      })),
    [efforts],
  );

  return (
    <div className="grid min-w-0 gap-4">
      <PageHeader
        icon={RouteIcon}
        title={
          editing ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void rename(draft.trim() || null);
              }}
            >
              <Input
                autoFocus
                value={draft}
                maxLength={120}
                aria-label={t('maps.routes.name')}
                placeholder={routeTitle({ ...route, customName: null }, t, fmt, lang)}
                onChange={(e) => setDraft(e.target.value)}
                className="h-10 w-72 max-w-full text-lg font-semibold"
              />
              <IconButton type="submit" icon={Check} label={t('common.save')} disabled={saving} />
              <IconButton
                type="button"
                icon={X}
                label={t('common.cancel')}
                onClick={() => setEditing(false)}
              />
            </form>
          ) : (
            title
          )
        }
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <SportBadge sport={route.sport} />
            {/* the generated name already says kind and distance */}
            {route.customName && (
              <>
                <span aria-hidden>·</span>
                <span>{kindLabel(route.kind, t)}</span>
                <span aria-hidden>·</span>
                <span className="tabular">{fmt.distance(route.distanceM, 1)}</span>
              </>
            )}
          </span>
        }
        actions={
          !editing && (
            <Button
              icon={Pencil}
              onClick={() => {
                setDraft(route.customName ?? '');
                setEditing(true);
              }}
            >
              {t('maps.routes.rename')}
            </Button>
          )
        }
      />
      {error != null && <ErrorState error={error} />}

      <Card>
        <StatRow>
          <Stat
            label={t('maps.routes.timesDone')}
            value={`${fmt.int(route.count)}×`}
            hint={fmt.dateRange(route.firstTs, efforts[efforts.length - 1]?.tzMin ?? 0, route.lastTs, route.lastTzMin)}
          />
          <Stat
            label={t('maps.routes.best')}
            value={fmt.duration(route.bestTimeS)}
            hint={best ? fmt.date(best.startTs, best.tzMin, 'day') : undefined}
          />
          <Stat
            label={t('maps.routes.latest')}
            value={fmt.duration(route.latestTimeS)}
            delta={
              route.count > 1 && route.latestTimeS !== route.bestTimeS ? (
                <Delta
                  value={route.latestTimeS - route.bestTimeS}
                  upIsGood={false}
                  text={`${signedDuration(fmt, route.latestTimeS - route.bestTimeS)} ${t('maps.routes.vsBest')}`}
                />
              ) : undefined
            }
            hint={
              route.count > 1 && route.latestTimeS === route.bestTimeS ? t('maps.routes.isBest') : undefined
            }
          />
          <Stat
            label={t('maps.routes.improvement')}
            value={improvement !== null && route.count > 2 ? fmt.pct(improvement, 1) : '–'}
            hint={t('maps.routes.improvementHint')}
          />
        </StatRow>
      </Card>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <RouteMapCard detail={detail} />
        <Compare best={best} latest={latest} sport={route.sport} />
      </div>

      <EffortTrend
        efforts={efforts}
        sport={route.sport}
        title={t('maps.routes.trendTitle')}
        subtitle={t('maps.routes.trendSubtitle')}
      />
      <EffortTable
        title={t('maps.routes.efforts')}
        subtitle={t('maps.routes.effortsSubtitle', { count: efforts.length })}
        rows={rows}
        sport={route.sport}
        bestLabel={t('maps.routes.rankBest')}
        initialSort={{ col: 'date', dir: 'desc' }}
      />
    </div>
  );
}

function RouteMapCard({ detail }: { detail: MapsRouteDetail }) {
  const t = useT();
  const chart = useChartTheme();
  const { route, tracks } = detail;
  const [overlay, onStylePref] = useShownOverlayColors();

  const { lines, bounds, markers } = useMemo(() => {
    const decoded = new Map(tracks.map((tr) => [tr.workoutId, toLngLat(decodePolyline(tr.polyline))]));
    const rep = route.polyline ? toLngLat(decodePolyline(route.polyline)) : [];
    const bestLine = decoded.get(route.bestWorkoutId);
    const latestLine = decoded.get(route.latestWorkoutId);
    const faint = [...decoded.entries()]
      .filter(([wid]) => wid !== route.bestWorkoutId && wid !== route.latestWorkoutId)
      .map(([, c]) => c);
    const out: MapLine[] = [];
    if (faint.length) out.push({ id: 'tracks', lines: faint, color: overlay.muted, width: 2, opacity: 0.55 });
    else if (rep.length)
      out.push({ id: 'tracks', lines: [rep], color: overlay.muted, width: 2, opacity: 0.55 });
    if (latestLine && route.latestWorkoutId !== route.bestWorkoutId)
      out.push({
        id: 'latest',
        lines: [latestLine],
        color: chart.series[1]!,
        width: 4,
        casing: overlay.casing,
      });
    if (bestLine)
      out.push({ id: 'best', lines: [bestLine], color: chart.series[0]!, width: 4, casing: overlay.casing });
    let box: BBox | null = null;
    for (const c of [rep, ...decoded.values()]) {
      for (const [lo, la] of c) box = unionBox(box, [lo, la, lo, la]);
    }
    const start = rep[0] ?? null;
    const end = rep[rep.length - 1] ?? null;
    return {
      lines: out,
      bounds: box,
      markers: [
        { id: 'start', coord: start, color: chart.status.good },
        { id: 'end', coord: end, color: chart.fg },
      ],
    };
  }, [
    tracks,
    route.polyline,
    route.bestWorkoutId,
    route.latestWorkoutId,
    overlay.muted,
    overlay.casing,
    chart,
  ]);

  return (
    <Card padded={false} className="flex min-h-[22rem] flex-col overflow-hidden">
      <LineMap
        className="min-h-[22rem] flex-1 rounded-none"
        lines={lines}
        markers={markers}
        bounds={bounds}
        padding={56}
        onStylePref={onStylePref}
      >
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col gap-1 rounded-lg border border-border bg-surface/90 px-2.5 py-1.5 text-xs text-fg-2 shadow-card backdrop-blur">
          <LegendItem color={chart.series[0]!} label={t('maps.routes.best')} />
          {route.latestWorkoutId !== route.bestWorkoutId && (
            <LegendItem color={chart.series[1]!} label={t('maps.routes.latest')} />
          )}
          <LegendItem color={overlay.muted} label={t('maps.routes.otherEfforts')} />
        </div>
      </LineMap>
    </Card>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-0.5 w-4 rounded-full" style={{ background: color }} aria-hidden />
      {label}
    </span>
  );
}

function Compare({
  best,
  latest,
  sport,
}: {
  best?: MapsRouteEffort;
  latest?: MapsRouteEffort;
  sport: string;
}) {
  const t = useT();
  const fmt = useFormat();
  const { lang } = useI18n();
  if (!best || !latest) return null;
  const same = best.workoutId === latest.workoutId;
  const col = (label: string, e: MapsRouteEffort, color: string) => (
    <div
      className="min-w-0 rounded-control border border-border p-3"
      style={{ borderTopColor: color, borderTopWidth: 3 }}
    >
      <div className="text-xs font-medium text-fg-3">{label}</div>
      <Link
        to={`/activities/${e.workoutId}`}
        className="mt-0.5 block truncate text-sm font-semibold text-fg hover:text-accent-fg"
      >
        {fmt.date(e.startTs, e.tzMin, 'day')}
      </Link>
      <div className="truncate text-xs text-fg-3">{workoutTitle(e, lang)}</div>
      <dl className="mt-3 space-y-1.5 text-sm">
        <Row k={t('maps.routes.time')} v={fmt.duration(e.timeS)} />
        <Row k={t(speedLabelKey(sport))} v={fmt.pace(e.avgSpeed, sport)} />
        <Row k={t('common.avgHr')} v={e.avgHr ? fmt.hr(e.avgHr) : '–'} />
      </dl>
    </div>
  );
  const dTime = latest.timeS - best.timeS;
  return (
    <Card className="flex flex-col">
      <CardHeader title={t('maps.routes.bestVsLatest')} />
      {same ? (
        <p className="mb-3 inline-flex items-center gap-2 text-sm text-fg-2">
          <Trophy size={16} className="text-accent-fg" aria-hidden />
          {t('maps.routes.latestIsBest')}
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
        {col(t('maps.routes.best'), best, 'var(--series-1)')}
        {!same && col(t('maps.routes.latest'), latest, 'var(--series-2)')}
      </div>
      {!same && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-2">
          <span className="inline-flex items-center gap-1.5">
            {t('maps.routes.time')}
            <Delta value={dTime} upIsGood={false} text={signedDuration(fmt, dTime)} />
          </span>
          {best.avgHr != null && latest.avgHr != null && (
            <span className="inline-flex items-center gap-1.5">
              {t('common.avgHr')}
              <Delta
                value={latest.avgHr - best.avgHr}
                upIsGood={false}
                text={`${fmt.signed(latest.avgHr - best.avgHr)} bpm`}
              />
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-fg-3">{k}</dt>
      <dd className="font-medium text-fg tabular">{v}</dd>
    </div>
  );
}
