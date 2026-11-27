import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { Flame, Globe, Maximize2, Pause, Play, RotateCcw, Timer, X } from 'lucide-react';
import type { MapsHeatmapActivity, MapsHeatmapResponse } from '@cadence/shared';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  FilterBar,
  IconButton,
  Page,
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
  Slider,
  Switch,
  cn,
} from '@/components/ui';
import { useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { SportIcon, sortSports, sportColorVar, useSportLabel } from '@/lib/sports';
import { useStoredState } from '@/lib/storage';
import { Store, useThrottledStore } from '@/lib/store';
import { addDays, todayKey } from '@/lib/time';
import { HeatmapMap } from '../components/HeatmapMap';
import { countVars } from '../lib/counts';
import { lapseAt, mainBounds, toHeatLines, type HeatBase, type HeatTheme } from '../lib/heatmapLayers';
import { sameBounds } from '../lib/home';
import { speedLabel } from '../lib/timelapse';

const THEMES: HeatTheme[] = ['hot', 'blue', 'purple'];
const THEME_DOT: Record<HeatTheme, string> = { hot: '#ff8a1f', blue: '#2aa3ff', purple: '#b04dff' };
const BASES: HeatBase[] = ['dark', 'satellite', 'streets'];
const SPEEDS = [0.5, 1, 2, 4] as const;

/** Seconds a full time-lapse takes at 1× (the rate adapts to the number of activities). */
const LAPSE_SECONDS = 30;

/** period key → local day range */
function periodRange(period: string): { fromDay?: string; toDay?: string } {
  if (period === 'all') return {};
  const today = todayKey();
  if (period === 'last90') return { fromDay: addDays(today, -89), toDay: today };
  if (period === 'last12m') return { fromDay: addDays(today, -364), toDay: today };
  if (/^y\d{4}$/.test(period))
    return { fromDay: `${period.slice(1)}-01-01`, toDay: `${period.slice(1)}-12-31` };
  return {};
}

export default function HeatmapPage() {
  const t = useT();
  const fmt = useFormat();
  const sportLabel = useSportLabel();

  const [sports, setSports] = useState<string[]>([]);
  const [period, setPeriod] = useState('all');
  const [theme, setTheme] = useStoredState<HeatTheme>('maps.heatmap.theme', 'hot');
  const [base, setBase] = useStoredState<HeatBase>('maps.heatmap.base', 'dark');
  const [density, setDensity] = useStoredState('maps.heatmap.density', false);
  const [fitNonce, setFitNonce] = useState(0);
  const [showAll, setShowAll] = useState(false);

  const range = useMemo(() => periodRange(period), [period]);
  const q = useApi<MapsHeatmapResponse>(['maps', 'heatmap'], '/maps/heatmap', {
    sport: sports.length ? [...sports].sort().join(',') : undefined,
    fromDay: range.fromDay,
    toDay: range.toDay,
  });
  const data = q.data;
  const items = data?.items;
  const lines = useMemo(() => toHeatLines(items ?? []), [items]);
  // activities that could be decoded, in the same order as `lines`
  const activities = useMemo(() => {
    const ids = new Set(lines.map((l) => l.id));
    return (items ?? []).filter((a) => ids.has(a.id));
  }, [items, lines]);

  // The initial view is the "home region" so that a single trip abroad does not zoom out to the whole world.
  const homeBounds = useMemo(() => mainBounds(lines), [lines]);
  const hasFarRoutes = !!data && !!homeBounds && !sameBounds(homeBounds, data.bounds);
  const bounds = showAll && hasFarRoutes ? data!.bounds : (homeBounds ?? data?.bounds ?? null);
  useEffect(() => setShowAll(false), [sports, period]);

  // ----- time-lapse ---------------------------------------------------------------------------------------
  // The position (in activities) changes every animation frame. It lives in a store that the map follows by itself
  // and the caption and scrubber read throttled: the page only re-renders when the time-lapse starts, pauses or stops.
  const [lapseOn, setLapseOn] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [progress] = useState(() => new Store(0));
  const count = lines.length;

  const seek = useCallback((p: number) => progress.set(p), [progress]);

  // new data / filter → restart
  useEffect(() => {
    seek(0);
    setPlaying(lapseOn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines]);

  useEffect(() => {
    if (!playing || count === 0) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const rate = Math.max(1.5, count / LAPSE_SECONDS) * speed;
      const next = Math.min(count, progress.get() + dt * rate);
      seek(next);
      if (next >= count) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, count, seek, progress]);

  const startLapse = () => {
    seek(0);
    setLapseOn(true);
    setPlaying(true);
  };
  const stopLapse = () => {
    setLapseOn(false);
    setPlaying(false);
  };
  const togglePlay = () => {
    if (!playing && progress.get() >= count) seek(0);
    setPlaying((p) => !p);
  };

  const cumDistance = useMemo(() => {
    const out = [0];
    activities.forEach((a, i) => out.push(out[i]! + (a.distanceM ?? 0)));
    return out;
  }, [activities]);

  // ----- filters -----------------------------------------------------------------------------------------
  const facetSports = useMemo(() => (data ? sortSports(data.facets.sports.map((s) => s.sport)) : []), [data]);
  const toggleSport = (s: string) =>
    setSports((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const periodOptions = useMemo(() => {
    const years = [...(data?.facets.years ?? [])].map((y) => y.year).sort((a, b) => b - a);
    return [
      { value: 'all', label: t('common.allTime') },
      { value: 'last90', label: t('common.last90') },
      { value: 'last12m', label: t('common.last12m') },
      ...years.map((y) => ({ value: `y${y}`, label: String(y) })),
    ];
  }, [data, t]);

  const noRoutes = !!data && data.facets.sports.length === 0;
  const mapHeight = 'h-[clamp(460px,calc(100vh-18rem),900px)]';

  return (
    <Page wide>
      <PageHeader
        icon={Flame}
        title={t('maps.titles.HeatmapPage')}
        subtitle={t('maps.heatmap.subtitle')}
        actions={
          !noRoutes && (
            <Button
              variant={lapseOn ? 'primary' : 'secondary'}
              icon={Timer}
              disabled={count === 0}
              onClick={lapseOn ? stopLapse : startLapse}
            >
              {t('maps.heatmap.timelapse')}
            </Button>
          )
        }
      >
        {!noRoutes && (
          <FilterBar className="gap-x-3 gap-y-2">
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('common.sport')}>
              <button
                type="button"
                aria-pressed={sports.length === 0}
                onClick={() => setSports([])}
                className={chipClass(sports.length === 0)}
              >
                {t('common.allSports')}
              </button>
              {facetSports.map((s) => (
                <button
                  type="button"
                  key={s}
                  aria-pressed={sports.includes(s)}
                  onClick={() => toggleSport(s)}
                  className={chipClass(sports.includes(s))}
                >
                  <span style={{ color: sportColorVar(s) }}>
                    <SportIcon sport={s} size={13} strokeWidth={2.5} />
                  </span>
                  {sportLabel(s)}
                </button>
              ))}
            </div>
            <div className="w-44 [&>select]:w-full">
              <Select
                value={period}
                onChange={setPeriod}
                options={periodOptions}
                aria-label={t('maps.heatmap.period')}
              />
            </div>
            <SegmentedControl
              label={t('maps.heatmap.colors')}
              value={theme}
              onChange={setTheme}
              items={THEMES.map((k) => ({
                value: k,
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="size-2.5 rounded-full"
                      style={{ background: THEME_DOT[k] }}
                      aria-hidden
                    />
                    {t(`maps.heatmap.themes.${k}`)}
                  </span>
                ),
              }))}
            />
            <SegmentedControl
              label={t('maps.heatmap.basemap')}
              value={base}
              onChange={setBase}
              items={BASES.map((k) => ({ value: k, label: t(`maps.heatmap.bases.${k}`) }))}
            />
            <Switch checked={density} onChange={setDensity} label={t('maps.heatmap.density')} />
          </FilterBar>
        )}
      </PageHeader>

      {q.isError && <ErrorState error={q.error} />}

      {!data && !q.isError && <Skeleton className={cn('w-full rounded-card', mapHeight)} />}

      {noRoutes && (
        <Card>
          <EmptyState
            icon={Flame}
            title={t('maps.heatmap.empty')}
            description={t('maps.heatmap.emptyHint')}
          />
        </Card>
      )}

      {data && !noRoutes && (
        <>
          <HeatmapMap
            className={cn('w-full', mapHeight)}
            activities={activities}
            lines={lines}
            theme={theme}
            base={base}
            density={density}
            bounds={bounds}
            lapse={lapseOn ? progress : null}
            fitNonce={fitNonce}
          >
            <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col items-start gap-1.5">
              <div className="rounded-lg border border-border bg-surface/90 px-2.5 py-1.5 text-xs text-fg-2 shadow-card backdrop-blur">
                <span className="font-semibold text-fg tabular">{t('maps.heatmap.activities', countVars(fmt, count))}</span> ·{' '}
                <span className="font-semibold text-fg tabular">{fmt.distance(data.totalDistanceM, 0)}</span>
              </div>
              {data.privacyApplied && (
                <div className="rounded-lg border border-border bg-surface/90 px-2.5 py-1 text-xs text-fg-3 shadow-card backdrop-blur">
                  {t('maps.heatmap.privacy')}
                </div>
              )}
              {q.isFetching && (
                <div className="rounded-lg bg-surface/90 px-2 py-1 text-xs text-fg-3">
                  {t('common.loading')}
                </div>
              )}
            </div>
            <div className="absolute right-3 top-3 z-10 flex gap-1.5">
              {hasFarRoutes && (
                <IconButton
                  icon={Globe}
                  label={showAll ? t('maps.heatmap.fit') : t('maps.heatmap.showAll')}
                  active={showAll}
                  onClick={() => setShowAll((v) => !v)}
                  className="border border-border bg-surface shadow-card"
                />
              )}
              <IconButton
                icon={Maximize2}
                label={t('maps.heatmap.fit')}
                onClick={() => setFitNonce((n) => n + 1)}
                className="border border-border bg-surface shadow-card"
              />
            </div>
            {lapseOn && (
              <>
                <LapseCaption progress={progress} activities={activities} count={count} cumDistance={cumDistance} />
                <div className="absolute bottom-8 left-3 right-14 z-10 flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface/90 px-2.5 py-1.5 shadow-card backdrop-blur">
                  <IconButton
                    icon={playing ? Pause : Play}
                    label={playing ? t('maps.heatmap.pause') : t('maps.heatmap.play')}
                    onClick={togglePlay}
                    active
                  />
                  <IconButton icon={RotateCcw} label={t('maps.heatmap.restart')} onClick={() => seek(0)} />
                  <div className="min-w-32 flex-1">
                    <LapseSlider progress={progress} count={count} label={t('maps.heatmap.scrub')} />
                  </div>
                  <SegmentedControl
                    size="sm"
                    label={t('maps.heatmap.speed')}
                    value={String(speed)}
                    onChange={(v) => setSpeed(Number(v))}
                    items={SPEEDS.map((s) => ({ value: String(s), label: speedLabel(fmt, s) }))}
                  />
                  <IconButton icon={X} label={t('maps.heatmap.exitTimelapse')} onClick={stopLapse} />
                </div>
              </>
            )}
          </HeatmapMap>
          {count === 0 && <p className="mt-3 text-sm text-fg-3">{t('maps.heatmap.noMatch')}</p>}
        </>
      )}
    </Page>
  );
}

/** Date, number and distance of the time-lapse: follows the position at most ten times a second. */
function LapseCaption({
  progress,
  activities,
  count,
  cumDistance,
}: {
  progress: Store<number>;
  activities: MapsHeatmapActivity[];
  count: number;
  cumDistance: number[];
}) {
  const fmt = useFormat();
  const { done, frac } = lapseAt(useThrottledStore(progress, 100), count);
  const current = activities[Math.min(done, Math.max(0, activities.length - 1))];
  if (!current) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center" aria-live="polite">
      <div className="rounded-xl border border-border bg-surface/90 px-4 py-1.5 text-center shadow-card backdrop-blur">
        <div className="text-lg font-semibold tracking-tight text-fg tabular">
          {fmt.date(current.startTs, current.tzMin, 'day')}
        </div>
        <div className="text-xs text-fg-3 tabular">
          {fmt.int(Math.min(count, done + (frac > 0 ? 1 : 0)))} / {fmt.int(count)} ·{' '}
          {fmt.distance(cumDistance[done] ?? 0, 0)}
        </div>
      </div>
    </div>
  );
}

/** Time-lapse scrubber: follows the position throttled, shows a drag at once. */
function LapseSlider({ progress, count, label }: { progress: Store<number>; count: number; label: string }) {
  const p = useThrottledStore(progress, 100);
  // a controlled range input snaps back to the rendered value: render a drag right away (the render reads the store)
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  return (
    <Slider
      value={Math.min(count, Math.floor(p))}
      min={0}
      max={Math.max(1, count)}
      label={label}
      onChange={(v) => {
        progress.set(v);
        rerender();
      }}
    />
  );
}

function chipClass(active: boolean): string {
  return cn(
    'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition-colors',
    active
      ? 'border-accent/50 bg-accent-soft text-accent-fg'
      : 'border-border bg-surface text-fg-2 hover:bg-surface-2 hover:text-fg',
  );
}
