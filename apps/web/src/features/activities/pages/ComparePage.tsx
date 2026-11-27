import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Activity, ArrowLeft, ArrowLeftRight, GitCompareArrows, Info, SearchX } from 'lucide-react';
import { workoutTitle, type WorkoutDetail } from '@cadence/shared';
import { PlaceText } from '@/components/map/PlaceText';
import { Button, Card, EmptyState, ErrorState, FilterBar, Page, SegmentedControl, Skeleton } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useStoredState } from '@/lib/storage';
import { SportIcon, sportLabel } from '@/lib/sports';
import { Store } from '@/lib/store';
import { useStreams, useWorkout } from '../api';
import { CompareCharts } from '../components/compare/CompareCharts';
import { CompareDialog } from '../components/compare/CompareDialog';
import { CompareMap, SIDE_VAR } from '../components/compare/CompareMap';
import { CompareReplay } from '../components/compare/CompareReplay';
import { CompareSummary } from '../components/compare/CompareSummary';
import { align, replayClock, routeSeparation, type Alignment, type TimeBase } from '../lib/compare';
import { Playback } from '../lib/playback';
import { routeGeometry } from '../lib/route';
import { prepareStreams, type Prepared } from '../lib/streams';
import { usePlaybackKeys } from '../lib/usePlaybackKeys';

type Side = 'a' | 'b';

/** Routes further apart than this (median, at the same distance) are not the same route. */
const OTHER_ROUTE_M = 150;

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm text-fg-2">
      <Info size={15} className="mt-0.5 shrink-0 text-fg-3" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function SideCard({ w, side }: { w: WorkoutDetail; side: Side }) {
  const { lang } = useI18n();
  const fmt = useFormat();
  return (
    <Card className="min-w-0" padded={false}>
      <div className="flex items-start gap-3 p-4">
        <span
          className="grid size-9 shrink-0 place-items-center rounded-full text-sm font-bold text-white"
          style={{ background: SIDE_VAR[side] }}
          aria-hidden
        >
          {side.toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <Link
            to={`/activities/${w.id}`}
            className="block truncate text-base font-semibold text-fg hover:text-accent-fg hover:underline"
          >
            <span className="sr-only">{side.toUpperCase()}: </span>
            {workoutTitle(w, lang)}
          </Link>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-fg-3">
            <span className="inline-flex items-center gap-1">
              <SportIcon sport={w.sport} size={13} />
              {sportLabel(w.sport, lang)}
            </span>
            <span aria-hidden>·</span>
            <time dateTime={new Date(w.startTs * 1000).toISOString()}>{fmt.date(w.startTs, w.tzMin, 'dateTime')}</time>
            {w.place && (
              <>
                <span aria-hidden>·</span>
                <PlaceText w={w} />
              </>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

/** Map + replay (both with GPS) and the charts. */
function CompareBody({
  sport,
  A,
  B,
  al,
  names,
}: {
  sport: string;
  A: Prepared;
  B: Prepared;
  al: Alignment;
  names: Record<Side, string>;
}) {
  const { t } = useI18n();
  const geoA = useMemo(() => routeGeometry(A), [A]);
  const geoB = useMemo(() => routeGeometry(B), [B]);
  const clock = useMemo(() => replayClock(A, B, al), [A, B, al]);
  const playback = useMemo(() => new Playback(clock), [clock]);
  useEffect(() => () => playback.dispose(), [playback]);
  const hover = useMemo(() => new Store<number | null>(null), []);
  const showMap = al.mode === 'distance' && !!geoA && !!geoB;
  usePlaybackKeys(showMap ? playback : null);

  const charts = <CompareCharts A={A} B={B} al={al} sport={sport} hover={hover} names={names} />;
  if (!showMap)
    return (
      <div className="grid gap-4">
        {al.mode === 'distance' && (A.hasGps || B.hasGps) && <Notice>{t('activities.compare.noMap')}</Notice>}
        {charts}
      </div>
    );
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <Card className="grid min-w-0 gap-3 xl:sticky xl:top-4">
        <CompareMap A={A} B={B} geoA={geoA!} geoB={geoB!} al={al} playback={playback} hover={hover} names={names} />
        <CompareReplay A={A} B={B} al={al} playback={playback} />
      </Card>
      <div className="grid min-w-0 gap-4">
        {charts}
        <p className="text-xs text-fg-3">{t('activities.compare.charts.hint')}</p>
      </div>
    </div>
  );
}

function CompareView({ aId, bId }: { aId: number; bId: number }) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const navigate = useNavigate();
  const da = useWorkout(aId);
  const db = useWorkout(bId);
  const sa = useStreams(aId);
  const sb = useStreams(bId);
  const [base, setBase] = useStoredState<TimeBase>('activities.compareTime', 'moving');
  const [picking, setPicking] = useState(false);
  const A = useMemo(() => (sa.data ? prepareStreams(sa.data) : null), [sa.data]);
  const B = useMemo(() => (sb.data ? prepareStreams(sb.data) : null), [sb.data]);
  const al = useMemo(() => (A && B ? align(A, B, base) : null), [A, B, base]);
  const separation = useMemo(() => (A && B && al ? routeSeparation(A, B, al) : null), [A, B, al]);
  const a = da.data;
  const b = db.data;
  const names = useMemo<Record<Side, string>>(
    () => ({
      a: a ? `A · ${fmt.date(a.startTs, a.tzMin, 'day')}` : 'A',
      b: b ? `B · ${fmt.date(b.startTs, b.tzMin, 'day')}` : 'B',
    }),
    [a, b, fmt],
  );

  if (da.isLoading || db.isLoading)
    return (
      <Page wide>
        <Skeleton className="mb-3 h-5 w-40" />
        <Skeleton className="mb-4 h-9 w-72" />
        <div className="mb-4 grid gap-3 md:grid-cols-2">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
        <Skeleton className="h-[520px] w-full" />
      </Page>
    );
  if (!a || !b) {
    const error = da.error ?? db.error;
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <Page wide>
        {missing || !error ? (
          <Card>
            <EmptyState
              icon={SearchX}
              title={t('activities.compare.notFound')}
              description={t('activities.detail.notFoundHint')}
              action={
                <Link to={a ? `/activities/${a.id}` : '/activities'}>
                  <Button>{a ? t('activities.compare.back') : t('activities.detail.back')}</Button>
                </Link>
              }
            />
          </Card>
        ) : (
          <ErrorState error={error} />
        )}
      </Page>
    );
  }

  const common =
    al?.mode === 'distance' && al.tA && al.tB && A && B && Math.abs(A.totalDist - B.totalDist) > Math.max(30, 0.01 * al.span)
      ? { distM: al.span, a: al.tA[al.tA.length - 1]!, b: al.tB[al.tB.length - 1]! }
      : null;
  const streamsLoading = (sa.isLoading || sb.isLoading) && !(sa.data && sb.data);
  const noStreams = !streamsLoading && (!A || !B);

  return (
    <Page wide>
      <header className="mb-4 grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link to={`/activities/${a.id}`} className="inline-flex items-center gap-1.5 text-sm text-fg-3 hover:text-fg">
            <ArrowLeft size={15} aria-hidden />
            {t('activities.compare.back')}
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon={ArrowLeftRight} onClick={() => navigate(`/activities/${b.id}/compare/${a.id}`)}>
              {t('activities.compare.swap')}
            </Button>
            <Button size="sm" icon={GitCompareArrows} onClick={() => setPicking(true)}>
              {t('activities.compare.change')}
            </Button>
          </div>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{t('activities.titles.ComparePage')}</h1>
        <div className="grid gap-3 md:grid-cols-2" role="group" aria-label={t('activities.compare.sides')}>
          <SideCard w={a} side="a" />
          <SideCard w={b} side="b" />
        </div>
      </header>

      {al && (
        <FilterBar className="mb-4">
          <span className="text-xs font-medium text-fg-2">{t('activities.compare.timeBase')}</span>
          <SegmentedControl
            size="sm"
            label={t('activities.compare.timeBase')}
            value={base}
            onChange={setBase}
            items={[
              { value: 'moving', label: t('activities.compare.moving') },
              { value: 'elapsed', label: t('activities.compare.elapsed') },
            ]}
          />
          <span className="text-xs text-fg-3">{t('activities.compare.timeBaseHint')}</span>
        </FilterBar>
      )}

      <CompareSummary a={a} b={b} sport={a.sport} common={common} />

      <div className="mb-4 grid gap-1.5 empty:hidden">
        {a.sport !== b.sport && (
          <Notice>{t('activities.compare.otherSport', { a: sportLabel(a.sport, lang), b: sportLabel(b.sport, lang) })}</Notice>
        )}
        {common && <Notice>{t('activities.compare.common', { distance: fmt.distance(common.distM) })}</Notice>}
        {separation !== null && separation > OTHER_ROUTE_M && <Notice>{t('activities.compare.routesDiffer')}</Notice>}
        {al?.mode === 'time' && <Notice>{t('activities.compare.timeMode')}</Notice>}
      </div>

      {(sa.error || sb.error) && <ErrorState error={sa.error ?? sb.error} className="mb-4" />}
      {streamsLoading ? (
        <Skeleton className="h-[520px] w-full" />
      ) : noStreams ? (
        <Card>
          <EmptyState
            icon={Activity}
            title={t('activities.compare.noStreams')}
            description={
              !A && !B
                ? t('activities.compare.noStreamsBoth')
                : t('activities.compare.noStreamsOne', { name: `${!A ? 'A' : 'B'} (${workoutTitle(!A ? a : b, lang)})` })
            }
          />
        </Card>
      ) : al && A && B ? (
        <CompareBody sport={a.sport} A={A} B={B} al={al} names={names} />
      ) : (
        <Card>
          <EmptyState icon={Activity} title={t('activities.compare.tooShort')} />
        </Card>
      )}

      {picking && <CompareDialog w={a} onClose={() => setPicking(false)} />}
    </Page>
  );
}

/** '/activities/:id/compare/:otherId' — two activities side by side (A = :id, B = :otherId). */
export default function ComparePage() {
  const { id, otherId } = useParams();
  const { t } = useI18n();
  const a = Number(id);
  const b = Number(otherId);
  if (!Number.isInteger(a) || a <= 0 || !Number.isInteger(b) || b <= 0)
    return (
      <Page>
        <EmptyState icon={SearchX} title={t('activities.detail.notFound')} />
      </Page>
    );
  if (a === b)
    return (
      <Page>
        <Card>
          <EmptyState
            icon={GitCompareArrows}
            title={t('activities.compare.sameActivity')}
            action={
              <Link to={`/activities/${a}`}>
                <Button>{t('activities.compare.back')}</Button>
              </Link>
            }
          />
        </Card>
      </Page>
    );
  return <CompareView key={`${a}-${b}`} aId={a} bId={b} />;
}
