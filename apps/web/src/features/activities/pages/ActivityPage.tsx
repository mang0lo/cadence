import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Activity, SearchX } from 'lucide-react';
import type { ActivityAnalysis, WorkoutDetail, WorkoutStreams } from '@cadence/shared';
import { Button, Card, EmptyState, ErrorState, Page, Skeleton } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { useAnalysis, useNav, useStreams, useWorkout } from '../api';
import { ActivityHeader } from '../components/detail/ActivityHeader';
import { ActivityMap, type CameraMode } from '../components/detail/ActivityMap';
import { AnalysisSections } from '../components/detail/AnalysisSections';
import { HeroStats } from '../components/detail/HeroStats';
import { PlaybackBar } from '../components/detail/PlaybackBar';
import { SelectionPanel } from '../components/detail/SelectionPanel';
import { StreamCharts } from '../components/detail/StreamCharts';
import { Playback } from '../lib/playback';
import { routeGeometry } from '../lib/route';
import { Store } from '../lib/store';
import { prepareStreams } from '../lib/streams';

const DEFAULT_ZONE_BOUNDS = [114, 133, 152, 171];

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** Map, replay, charts and every analysis section; everything below the header. */
function ActivityBody({
  w,
  streams,
  analysis,
  analysisLoading,
  analysisError,
  zoneBounds,
}: {
  w: WorkoutDetail;
  streams: WorkoutStreams;
  analysis: ActivityAnalysis | undefined;
  analysisLoading: boolean;
  analysisError: unknown;
  zoneBounds: number[];
}) {
  const { t } = useI18n();
  const P = useMemo(() => prepareStreams(streams), [streams]);
  const geo = useMemo(() => (P ? routeGeometry(P) : null), [P]);
  const playback = useMemo(() => (P && geo ? new Playback(P) : null), [P, geo]);
  const hover = useMemo(() => new Store<number | null>(null), []);
  const [selection, setSelection] = useState<[number, number] | null>(null);
  const [camera, setCamera] = useState<CameraMode>('overview');

  useEffect(() => () => playback?.dispose(), [playback]);

  // keyboard: space play/pause, ←/→ jump 1 % (shift 5 %), +/− speed
  useEffect(() => {
    if (!playback) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === ' ' || e.code === 'Space') {
        if (e.target instanceof Element && e.target.closest('button, a, summary, [role="radio"], [role="slider"]')) return;
        e.preventDefault();
        playback.toggle();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        playback.step((e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 0.05 : 0.01));
      } else if (e.key === '+' || e.key === '=') playback.faster(1);
      else if (e.key === '-' || e.key === '_') playback.faster(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playback]);

  if (!P)
    return (
      <>
        <Card className="mb-4">
          <EmptyState icon={Activity} title={t('activities.detail.noStreams')} description={t('activities.detail.noStreamsHint')} />
        </Card>
        <AnalysisSections
          w={w}
          P={null}
          analysis={analysis}
          analysisLoading={analysisLoading}
          analysisError={analysisError}
          zoneBounds={zoneBounds}
          onSelect={setSelection}
        />
      </>
    );

  const charts = (
    <StreamCharts
      P={P}
      sport={w.sport}
      zoneBounds={zoneBounds}
      playback={playback}
      hover={hover}
      selection={selection}
      onSelect={setSelection}
    />
  );
  const selectionPanel = selection && (
    <SelectionPanel P={P} sport={w.sport} selection={selection} onClear={() => setSelection(null)} />
  );

  return (
    <>
      {geo && playback ? (
        <div className="mb-4 grid items-start gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <Card className="grid min-w-0 gap-3 xl:sticky xl:top-4">
            <ActivityMap
              P={P}
              geo={geo}
              sport={w.sport}
              playback={playback}
              hover={hover}
              selection={selection}
              zoneBounds={zoneBounds}
              camera={camera}
              onCamera={setCamera}
            />
            <PlaybackBar P={P} playback={playback} sport={w.sport} zoneBounds={zoneBounds} />
          </Card>
          <div className="grid min-w-0 gap-4">
            {charts}
            {selectionPanel}
          </div>
        </div>
      ) : (
        <div className="mb-4 grid gap-4">
          {charts}
          {selectionPanel}
        </div>
      )}
      <AnalysisSections
        w={w}
        P={P}
        analysis={analysis}
        analysisLoading={analysisLoading}
        analysisError={analysisError}
        zoneBounds={zoneBounds}
        onSelect={setSelection}
      />
    </>
  );
}

function ActivityView({ id }: { id: number }) {
  const { t } = useI18n();
  const { athlete } = useSettings();
  const detail = useWorkout(id);
  const streams = useStreams(id);
  const analysis = useAnalysis(id);
  const nav = useNav(id);
  const zoneBounds = athlete?.hr.zoneBounds ?? DEFAULT_ZONE_BOUNDS;

  if (detail.isLoading)
    return (
      <Page wide>
        <Skeleton className="mb-3 h-5 w-40" />
        <Skeleton className="mb-6 h-10 w-2/3" />
        <Skeleton className="mb-4 h-32 w-full" />
        <Skeleton className="h-[520px] w-full" />
      </Page>
    );
  if (detail.error || !detail.data) {
    const missing = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <Page wide>
        {missing ? (
          <Card>
            <EmptyState
              icon={SearchX}
              title={t('activities.detail.notFound')}
              description={t('activities.detail.notFoundHint')}
              action={
                <Link to="/activities">
                  <Button>{t('activities.detail.back')}</Button>
                </Link>
              }
            />
          </Card>
        ) : (
          <ErrorState error={detail.error ?? t('common.unknown')} />
        )}
      </Page>
    );
  }
  const w = detail.data;
  return (
    <Page wide>
      <ActivityHeader w={w} nav={nav.data} />
      <HeroStats w={w} analysis={analysis.data} />
      {streams.error && <ErrorState error={streams.error} className="mb-4" />}
      {streams.data ? (
        <ActivityBody
          w={w}
          streams={streams.data}
          analysis={analysis.data}
          analysisLoading={analysis.isLoading}
          analysisError={analysis.error}
          zoneBounds={zoneBounds}
        />
      ) : (
        streams.isLoading && <Skeleton className="h-[520px] w-full" />
      )}
    </Page>
  );
}

/** '/activities/:id' — the activity page; remounted per id so maps, replay and selection start fresh. */
export default function ActivityPage() {
  const { id } = useParams();
  const n = Number(id);
  const { t } = useI18n();
  if (!Number.isInteger(n) || n <= 0)
    return (
      <Page>
        <EmptyState icon={SearchX} title={t('activities.detail.notFound')} />
      </Page>
    );
  return <ActivityView key={n} id={n} />;
}
