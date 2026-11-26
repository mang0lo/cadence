import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Waypoints } from 'lucide-react';
import {
  MIN_SEGMENT_M,
  profileSlice,
  segmentSports,
  workoutTitle,
  type MapsSegmentDetail,
  type MapsSegmentSource,
  type Page as PageDto,
  type WorkoutSummary,
} from '@cadence/shared';
import { useChartTheme } from '@/components/charts/theme';
import { RouteThumbnail } from '@/components/map/RouteThumbnail';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Field,
  Input,
  KeyValues,
  Page,
  PageHeader,
  Skeleton,
} from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useI18n, useT } from '@/lib/i18n';
import { SportBadge, sportColorVar, useSportLabel } from '@/lib/sports';
import { LineMap, useShownOverlayColors, type MapLine, type MapMarker } from '../components/LineMap';
import { RangeProfile } from '../components/RangeProfile';
import { unionBox, type BBox } from '../lib/home';
import { elapsedBetween, pointAt, slicePoints } from '../lib/segments';

/** /maps/segments/new?workout=:id – pick a part of an activity's route and save it as a segment. */
export default function SegmentNewPage() {
  const t = useT();
  const [params] = useSearchParams();
  const workout = Number(params.get('workout'));
  return (
    <Page wide>
      <div className="mb-3">
        <Link to={Number.isInteger(workout) && workout > 0 ? `/activities/${workout}` : '/maps/segments'}>
          <Button variant="ghost" size="sm" icon={ArrowLeft}>
            {Number.isInteger(workout) && workout > 0
              ? t('maps.segments.new.backToActivity')
              : t('maps.titles.SegmentsPage')}
          </Button>
        </Link>
      </div>
      <PageHeader
        icon={Waypoints}
        title={t('maps.titles.SegmentNewPage')}
        subtitle={t('maps.segments.new.subtitle')}
      />
      {Number.isInteger(workout) && workout > 0 ? <Editor workoutId={workout} /> : <Picker />}
    </Page>
  );
}

/** Choose the activity to draw the segment on. */
function Picker() {
  const t = useT();
  const fmt = useFormat();
  const { lang } = useI18n();
  const [, setParams] = useSearchParams();
  const q = useApi<PageDto<WorkoutSummary>>(['maps', 'segment-picker'], '/workouts', {
    hasRoute: true,
    sort: 'start',
    order: 'desc',
    limit: 24,
  });
  return (
    <Card>
      <CardHeader title={t('maps.segments.new.pickTitle')} subtitle={t('maps.segments.new.pickHint')} />
      {q.isError && <ErrorState error={q.error} />}
      {!q.data && !q.isError && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      )}
      {q.data && q.data.items.length === 0 && (
        <EmptyState
          icon={Waypoints}
          title={t('maps.heatmap.empty')}
          description={t('maps.heatmap.emptyHint')}
        />
      )}
      {q.data && (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {q.data.items.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                onClick={() => setParams({ workout: String(w.id) })}
                className="block w-full overflow-hidden rounded-card border border-border bg-surface text-left transition-colors hover:border-border-strong"
              >
                <RouteThumbnail
                  polyline={w.polyline}
                  color={sportColorVar(w.sport)}
                  width={260}
                  height={110}
                  className="h-28 w-full rounded-none"
                />
                <div className="p-3">
                  <div className="truncate text-sm font-semibold text-fg">{workoutTitle(w, lang)}</div>
                  <div className="text-xs text-fg-3">
                    {fmt.date(w.startTs, w.tzMin, 'day')} · {fmt.distance(w.distanceM)}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Editor({ workoutId }: { workoutId: number }) {
  const t = useT();
  const q = useApi<MapsSegmentSource>(
    ['maps', 'segment-source', workoutId],
    `/maps/segments/source/${workoutId}`,
  );
  if (q.isError)
    return (
      <Card>
        <ErrorState error={q.error} />
        <div className="mt-3">
          <Link to="/maps/segments/new">
            <Button>{t('maps.segments.new.chooseOther')}</Button>
          </Link>
        </div>
      </Card>
    );
  if (!q.data)
    return (
      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Skeleton className="h-[34rem] rounded-card" />
        <Skeleton className="h-[34rem] rounded-card" />
      </div>
    );
  return <EditorBody source={q.data} key={q.data.workoutId} />;
}

function EditorBody({ source }: { source: MapsSegmentSource }) {
  const t = useT();
  const fmt = useFormat();
  const { lang } = useI18n();
  const sportLabel = useSportLabel();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const chart = useChartTheme();
  const [overlay, onStylePref] = useShownOverlayColors();
  const { points, totalM } = source;
  const breaksM = source.breaksM ?? [];

  // default selection: the middle third of the route (of its longest part when it was paused and continued elsewhere)
  const [range, setRange] = useState<[number, number]>(() => {
    const cuts = [0, ...breaksM, totalM];
    let p0 = 0;
    let p1 = totalM;
    for (let i = 0; i + 1 < cuts.length; i++)
      if (cuts[i + 1]! - cuts[i]! > p1 - p0 || i === 0) [p0, p1] = [cuts[i]!, cuts[i + 1]!];
    const len = p1 - p0;
    const a = Math.round(p0 + len / 3);
    const b = Math.max(a + MIN_SEGMENT_M, Math.round(p0 + (len * 2) / 3));
    return [a, Math.min(totalM, b)];
  });
  const [hover, setHover] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setError(null), [range, name]);

  const [from, to] = range;
  const stats = useMemo(() => profileSlice(points.dist, points.ele, from, to), [points, from, to]);
  const hasEle = points.ele.some((e) => e !== null);
  const time = useMemo(() => elapsedBetween(points, from, to), [points, from, to]);
  const speed = time && time > 0 ? (to - from) / time : null;

  const full = useMemo<[number, number][]>(() => points.lon.map((lo, i) => [lo, points.lat[i]!]), [points]);
  // one line per part of the track: the jump between parts (travelled while paused) is not drawn
  const fullParts = useMemo(() => {
    const out: [number, number][][] = [[]];
    let b = 0;
    full.forEach((c, i) => {
      while (b < breaksM.length && points.dist[i]! > breaksM[b]!) {
        if (out[out.length - 1]!.length) out.push([]);
        b++;
      }
      out[out.length - 1]!.push(c);
    });
    return out.filter((l) => l.length > 1);
  }, [full, points, breaksM]);
  const spansBreak = breaksM.some((m) => m > range[0] && m < range[1]);
  const selected = useMemo(() => slicePoints(points, from, to), [points, from, to]);
  const bounds = useMemo(() => {
    let b: BBox | null = null;
    for (const [lo, la] of full) b = unionBox(b, [lo, la, lo, la]);
    return b;
  }, [full]);

  const lines = useMemo<MapLine[]>(
    () => [
      { id: 'route', lines: fullParts, color: overlay.muted, width: 4, casing: overlay.casing, opacity: 1 },
      { id: 'selected', lines: [selected], color: chart.accent, width: 6, casing: overlay.casing },
    ],
    [fullParts, selected, overlay.muted, overlay.casing, chart.accent],
  );
  const markers = useMemo<MapMarker[]>(
    () => [
      { id: 'start', coord: selected[0] ?? null, color: chart.status.good, radius: 7 },
      { id: 'end', coord: selected[selected.length - 1] ?? null, color: chart.fg, radius: 7 },
      { id: 'hover', coord: hover === null ? null : pointAt(points, hover), color: chart.accent, radius: 5 },
    ],
    [selected, hover, points, chart],
  );

  const canSave = name.trim().length > 0 && to - from >= MIN_SEGMENT_M && !saving && !spansBreak;
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const d = await api.post<MapsSegmentDetail>('/maps/segments', {
        workoutId: source.workoutId,
        startM: Math.round(from * 10) / 10,
        endM: Math.round(to * 10) / 10,
        name: name.trim(),
      });
      await qc.invalidateQueries({ queryKey: ['maps'] });
      navigate(`/maps/segments/${d.segment.id}`);
    } catch (e) {
      setError(e);
      setSaving(false);
    }
  };

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="grid min-w-0 gap-4">
        <Card padded={false} className="flex min-h-[22rem] flex-col overflow-hidden">
          <LineMap
            className="min-h-[22rem] flex-1 rounded-none"
            lines={lines}
            markers={markers}
            bounds={bounds}
            padding={56}
            onStylePref={onStylePref}
          />
        </Card>
        <Card>
          <CardHeader
            title={t('maps.segments.new.pickRange')}
            subtitle={t('maps.segments.new.pickRangeHint', { min: fmt.shortDistance(MIN_SEGMENT_M) })}
          />
          <RangeProfile
            dist={points.dist}
            ele={points.ele}
            total={totalM}
            value={range}
            onChange={setRange}
            onHover={setHover}
            minGapM={MIN_SEGMENT_M}
          />
          {spansBreak && (
            <p className="mt-3 text-xs text-critical-fg" role="alert">
              {t('maps.segments.new.spansBreak')}
            </p>
          )}
        </Card>
      </div>

      <Card className="flex min-w-0 flex-col gap-4 self-start">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-fg">
            {workoutTitle(
              { name: source.name, sport: source.sport, startTs: source.startTs, tzMin: source.tzMin },
              lang,
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-fg-3">
            <SportBadge sport={source.sport} />
            <span aria-hidden>·</span>
            <span>{fmt.date(source.startTs, source.tzMin, 'day')}</span>
          </div>
        </div>

        <KeyValues
          items={[
            [t('common.distance'), fmt.distance(stats.distanceM, 2)],
            [t('common.elevationGain'), hasEle ? fmt.elevation(stats.gainM) : '–'],
            [t('maps.segments.elevationLoss'), hasEle ? fmt.elevation(stats.lossM) : '–'],
            [t('maps.segments.avgGrade'), stats.gradePct === null ? '–' : `${fmt.num(stats.gradePct, 1)} %`],
            [t('maps.segments.new.yourTime'), time === null ? '–' : fmt.duration(time)],
            [t('common.pace'), speed === null ? '–' : fmt.pace(speed, source.sport)],
          ]}
        />

        <Field
          label={t('maps.segments.name')}
          help={t('maps.segments.new.matchHint', {
            sports: segmentSports(source.sport).map(sportLabel).join(', '),
          })}
        >
          <Input
            value={name}
            maxLength={120}
            placeholder={t('maps.segments.new.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSave) void save();
            }}
          />
        </Field>
        {error != null && <ErrorState error={error} />}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            icon={Check}
            loading={saving}
            disabled={!canSave}
            onClick={() => void save()}
          >
            {t('maps.segments.new.save')}
          </Button>
          <Link to={`/activities/${source.workoutId}`}>
            <Button variant="ghost">{t('common.cancel')}</Button>
          </Link>
        </div>
        {saving && <p className="text-xs text-fg-3">{t('maps.segments.new.matching')}</p>}
        {source.existing.length > 0 && (
          <div className="border-t border-border pt-3 text-xs text-fg-3">
            <div className="mb-1 font-medium text-fg-2">{t('maps.segments.new.existing')}</div>
            <ul className="flex flex-wrap gap-x-3 gap-y-1">
              {source.existing.map((s) => (
                <li key={s.id}>
                  <Link to={`/maps/segments/${s.id}`} className="text-accent-fg hover:underline">
                    {s.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}
