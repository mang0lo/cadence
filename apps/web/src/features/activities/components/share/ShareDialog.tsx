import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Download, LineChart, Plus, Share2 } from 'lucide-react';
import { sportInfo, trackParts, workoutTitle, type WorkoutDetail, type WorkoutStreams } from '@cadence/shared';
import { thumbnailBasemap } from '@/components/map/tiles';
import { Button, Dialog, Field, SegmentedControl, Spinner, Switch } from '@/components/ui';
import { saveFile } from '@/lib/download';
import { showsPace, speedLabel, useFormat, type Formatter } from '@/lib/format';
import { useI18n, type TFunction } from '@/lib/i18n';
import { activityPlace } from '@/lib/places';
import { decodePolylineParts } from '@/lib/polyline';
import { useSettings } from '@/lib/settings';
import { SportIcon, sportLabel, sportSlot } from '@/lib/sports';
import { useStoredState } from '@/lib/storage';
import { useResolvedTheme } from '@/lib/theme';
import { dayKey } from '@/lib/time';
import { useStreams } from '../../api';
import { cadenceUnit, shortDistanceParts, shownGain } from '../../lib/display';
import {
  MAX_SHARE_CHARTS,
  MAX_SHARE_STATS,
  SHARE_CHART_KEYS,
  SHARE_FORMATS,
  SHARE_STAT_KEYS,
  chartSeries,
  hidePrivacyZones,
  shareFileName,
  shareSelection,
  type LatLon,
  type ShareBackground,
  type ShareChartKey,
  type ShareFormat,
  type ShareStatKey,
  type ShareTheme,
} from '../../lib/share';
import {
  canvasBlob,
  renderShareImage,
  type ShareChart,
  type ShareResult,
  type ShareStat,
} from '../../lib/shareImage';
import { haversine, simplifyIndices } from '../../lib/streams';
import { ToggleChip } from '../ToggleChip';

/** Every value the activity has, formatted for the image. */
function statCatalog(w: WorkoutDetail, fmt: Formatter, t: TFunction): Partial<Record<ShareStatKey, ShareStat>> {
  const info = sportInfo(w.sport);
  const out: Partial<Record<ShareStatKey, ShareStat>> = {};
  const moving = w.movingS ?? w.durationS;
  if ((w.distanceM ?? 0) > 0) {
    const d = w.sport === 'swim' ? shortDistanceParts(w.distanceM!, fmt) : fmt.distanceParts(w.distanceM);
    out.distance = { label: t('common.distance'), ...d };
  }
  out.movingTime = { label: t('common.movingTime'), value: fmt.duration(moving) };
  if (w.elapsedS > moving + 60) out.elapsedTime = { label: t('common.elapsedTime'), value: fmt.duration(w.elapsedS) };
  if (info.distance && (w.distanceM ?? 0) > 0 && w.avgSpeed) {
    // pace per km/mi (per 100 m for swims) and speed for every distance sport, whatever its usual display
    out.pace = { label: t('common.pace'), ...fmt.paceParts(w.avgSpeed, info.speedMode === 'pace100' ? w.sport : 'run') };
    out.speed = { label: t('common.speed'), ...fmt.speedParts(w.avgSpeed) };
  }
  if ((shownGain(w) ?? 0) >= 1) out.elevation = { label: t('common.elevationGain'), ...fmt.elevationParts(w.elevationGainM) };
  if (w.avgHr) out.avgHr = { label: t('common.avgHr'), value: fmt.int(w.avgHr), unit: 'bpm' };
  if (w.maxHr) out.maxHr = { label: t('common.maxHr'), value: fmt.int(w.maxHr), unit: 'bpm' };
  if (w.avgPower) out.avgPower = { label: t('activities.stats.avgPower'), value: fmt.int(w.avgPower), unit: 'W' };
  if (w.avgCadence)
    out.cadence = { label: t('activities.stats.avgCadence'), value: fmt.int(w.avgCadence), unit: cadenceUnit(w.sport) };
  if (w.energyKcal) out.calories = { label: t('common.calories'), value: fmt.int(w.energyKcal), unit: 'kcal' };
  if (w.effort !== null) out.effort = { label: t('common.effort'), value: fmt.int(w.effort) };
  return out;
}

/** What the image shows when the user has not chosen yet (the 0.2 defaults). */
function defaultStats(w: WorkoutDetail): ShareStatKey[] {
  const info = sportInfo(w.sport);
  if (info.distance && (w.distanceM ?? 0) > 0)
    return ['distance', 'movingTime', showsPace(w.sport) ? 'pace' : 'speed', 'elevation'];
  return ['movingTime', 'calories', 'avgHr', 'effort'];
}

/** Mini charts the streams allow, along the distance (time without distance). */
function chartCatalog(
  w: WorkoutDetail,
  s: WorkoutStreams | undefined,
  fmt: Formatter,
  t: TFunction,
): Partial<Record<ShareChartKey, ShareChart>> {
  const out: Partial<Record<ShareChartKey, ShareChart>> = {};
  if (!s || s.t.length < 10) return out;
  const x = s.dist && s.dist.length === s.t.length && s.dist[s.dist.length - 1]! > 100 ? s.dist : s.t;
  const opts = { breaks: s.breaks };
  const ele = s.ele ? chartSeries(x, s.ele, { ...opts, minRange: 20 }) : null;
  if (ele && w.hasRoute)
    out.elevation = {
      label: t('common.elevation'),
      value: w.elevationGainM ? `↗ ${fmt.elevation(w.elevationGainM)}` : '',
      series: ele,
      color: 'elevation',
    };
  if (s.speed && sportInfo(w.sport).speedMode !== 'none') {
    // standing still is not "slow": only moving samples
    const v = s.speed.map((sp, i) => (s.moving && !s.moving[i] ? null : sp));
    const sp = chartSeries(x, v, { ...opts, minRange: 0.5 });
    if (sp)
      out.pace = {
        label: speedLabel(t, w.sport),
        value: w.avgSpeed ? `Ø ${fmt.pace(w.avgSpeed, w.sport)}` : '',
        series: sp,
        color: 'sport',
      };
  }
  const hr = s.hr ? chartSeries(x, s.hr, { ...opts, minRange: 15 }) : null;
  if (hr) out.heartRate = { label: t('common.heartRate'), value: w.avgHr ? `Ø ${fmt.hr(w.avgHr)}` : '', series: hr, color: 'hr' };
  const pw = s.power ? chartSeries(x, s.power, { ...opts, minRange: 50 }) : null;
  if (pw) out.power = { label: t('common.power'), value: w.avgPower ? `Ø ${fmt.power(w.avgPower)}` : '', series: pw, color: 'power' };
  return out;
}

interface ShareShow {
  route: boolean;
  date: boolean;
  place: boolean;
}

/** The route at full resolution from the streams (simplified to below a pixel), else the stored polyline. */
function useRouteParts(w: WorkoutDetail, data: WorkoutStreams | undefined): LatLon[][] {
  return useMemo(() => {
    const s = data;
    if (s?.lat && s.lon && s.lat.length === s.t.length && s.lat.length > 1) {
      const out: LatLon[][] = [];
      const b = w.bounds;
      // ~1/4000 of the route's extent: far below a pixel of the 1080 px image
      const diag = b ? haversine(b[1], b[0], b[3], b[2]) : 10_000;
      const tol = Math.max(1, diag / 4000);
      for (const [a, e] of trackParts(s.t.length, s.breaks)) {
        const lat = Float64Array.from(s.lat.slice(a, e));
        const lon = Float64Array.from(s.lon.slice(a, e));
        if (lat.length < 2 || lat.some((v) => !Number.isFinite(v)) || lon.some((v) => !Number.isFinite(v))) continue;
        out.push(simplifyIndices(lat, lon, tol).map((i) => [lat[i]!, lon[i]!] as LatLon));
      }
      if (out.length) return out;
    }
    return w.polyline ? decodePolylineParts(w.polyline) : [];
  }, [data, w.polyline, w.bounds]);
}

/** Dialog with a live preview of the share image and its options; saves, shares or copies the PNG. */
export default function ShareDialog({ w, onClose }: { w: WorkoutDetail; onClose: () => void }) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const { settings } = useSettings();
  const resolved = useResolvedTheme();
  const zones = settings.privacyZones ?? [];
  const mapsOff = settings.thumbnailMaps === false;
  const streams = useStreams(w.id);
  const route = useRouteParts(w, streams.data);
  const hasRoute = route.some((p) => p.length >= 2);

  const [format, setFormat] = useStoredState<ShareFormat>('activities.shareFormat', 'square');
  const [background, setBackground] = useState<ShareBackground>(mapsOff || !w.hasRoute ? 'plain' : 'map');
  const [theme, setTheme] = useState<ShareTheme>(resolved);
  const [privacy, setPrivacy] = useState(true);
  const [show, setShow] = useStoredState<ShareShow>('activities.shareShow', { route: true, date: true, place: true });
  const bg: ShareBackground = !hasRoute && background === 'map' ? 'plain' : background;

  const priv = useMemo(() => (privacy && zones.length && hasRoute ? hidePrivacyZones(route, zones) : null), [privacy, zones, hasRoute, route]);
  const parts = priv ? priv.parts : route;

  // ---- what is on the image: values, charts (chosen per sport and remembered), date / place / route ----
  const catalog = useMemo(() => statCatalog(w, fmt, t), [w, fmt, t]);
  const availableStats = SHARE_STAT_KEYS.filter((k) => catalog[k]);
  const [storedStats, setStoredStats] = useStoredState<ShareStatKey[] | null>(`activities.shareStats.${w.sport}`, null);
  const statKeys = shareSelection(storedStats, availableStats, defaultStats(w), SHARE_STAT_KEYS, MAX_SHARE_STATS);
  const stats = useMemo<ShareStat[]>(() => statKeys.map((k) => catalog[k]!), [statKeys.join(), catalog]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleStat = (k: ShareStatKey, on: boolean) =>
    setStoredStats(on ? [...statKeys, k] : statKeys.filter((x) => x !== k));

  const charts = useMemo(() => chartCatalog(w, streams.data, fmt, t), [w, streams.data, fmt, t]);
  const availableCharts = SHARE_CHART_KEYS.filter((k) => charts[k]);
  const [storedCharts, setStoredCharts] = useStoredState<ShareChartKey[] | null>(`activities.shareCharts.${w.sport}`, null);
  const chartKeys = shareSelection(storedCharts, availableCharts, [], SHARE_CHART_KEYS, MAX_SHARE_CHARTS);
  const chosenCharts = useMemo(() => chartKeys.map((k) => charts[k]!), [chartKeys.join(), charts]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleChart = (k: ShareChartKey, on: boolean) =>
    setStoredCharts(on ? [...chartKeys, k] : chartKeys.filter((x) => x !== k));

  const title = workoutTitle(w, lang);
  const place = activityPlace(w, lang);
  const subtitle = [
    show.date ? fmt.date(w.startTs, w.tzMin, 'day') : null,
    show.date ? fmt.time(w.startTs, w.tzMin) : null,
    show.place ? place : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const filename = shareFileName(dayKey(w.startTs, w.tzMin), title);

  // ---- rendering (into a fresh canvas each time; the newest result wins) ----
  const iconRef = useRef<HTMLSpanElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const [result, setResult] = useState<ShareResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    setBusy(true);
    renderShareImage(
      {
        title,
        subtitle,
        sportLabel: sportLabel(w.sport, lang),
        sportSlot: sportSlot(w.sport),
        icon: iconRef.current?.querySelector('svg') ?? null,
        stats,
        charts: chosenCharts,
        parts: bg === 'sticker' || !show.route ? [] : parts,
        // without the route line the map still shows its area
        area: bg === 'map' && !show.route ? parts : undefined,
        showStart: !priv?.startHidden,
        showEnd: !priv?.endHidden,
        brand: t('common.appName'),
      },
      { format, background: bg, theme, basemap: thumbnailBasemap(settings.mapStyle, theme) },
    )
      .then((r) => {
        if (!current) return;
        setResult(r);
        setFailed(false);
        const el = preview.current;
        if (el) {
          el.width = r.canvas.width;
          el.height = r.canvas.height;
          const ctx = el.getContext('2d');
          ctx?.clearRect(0, 0, el.width, el.height);
          ctx?.drawImage(r.canvas, 0, 0);
        }
      })
      .catch(() => current && setFailed(true))
      .finally(() => current && setBusy(false));
    return () => {
      current = false;
    };
  }, [title, subtitle, w.sport, lang, stats, chosenCharts, show.route, bg, parts, priv, t, format, theme, settings.mapStyle]);

  // ---- output ----
  const [done, setDone] = useState<'saved' | 'copied' | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = window.setTimeout(() => setDone(null), 2500);
    return () => window.clearTimeout(id);
  }, [done]);
  const canShare = useMemo(() => {
    try {
      return !!navigator.canShare?.({ files: [new File([new Blob()], 'cadence.png', { type: 'image/png' })] });
    } catch {
      return false;
    }
  }, []);
  const canCopy = typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;

  const save = async () => {
    if (!result) return;
    setError(false);
    try {
      // the apps save the file themselves (and show nothing a browser download would)
      if (await saveFile(filename, await canvasBlob(result.canvas))) setDone('saved');
    } catch {
      setError(true);
    }
  };
  const share = async () => {
    if (!result) return;
    setError(false);
    try {
      const file = new File([await canvasBlob(result.canvas)], filename, { type: 'image/png' });
      await navigator.share({ files: [file], title });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) setError(true);
    }
  };
  const copy = async () => {
    if (!result) return;
    setError(false);
    try {
      // a promise keeps the clipboard write inside the click (Safari)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasBlob(result.canvas) })]);
      setDone('copied');
    } catch {
      setError(true);
    }
  };

  const status = failed
    ? t('activities.share.failed')
    : error
      ? t('activities.share.failed')
      : bg === 'map' && result?.mapFailed
        ? t('activities.share.mapFailed')
        : priv && !priv.parts.length && bg !== 'sticker'
          ? t('activities.share.privacyAll')
          : !hasRoute && bg !== 'sticker'
            ? t('activities.share.noRoute')
            : bg === 'sticker'
              ? t('activities.share.stickerHint')
              : null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('activities.share.title')}
      // wider than the default dialog: preview and options side by side (the important modifier wins over its width)
      className="w-[min(94vw,980px)]!"
      actions={
        <>
          <span className="mr-auto self-center text-xs text-fg-3" role="status">
            {done === 'saved' ? t('activities.share.saved') : done === 'copied' ? t('activities.share.copied') : ''}
          </span>
          {canCopy && (
            <Button icon={done === 'copied' ? Check : Copy} onClick={() => void copy()} disabled={!result || busy}>
              {t('activities.share.copy')}
            </Button>
          )}
          {canShare && (
            <Button icon={Share2} onClick={() => void share()} disabled={!result || busy}>
              {t('activities.share.share')}
            </Button>
          )}
          <Button variant="primary" icon={done === 'saved' ? Check : Download} onClick={() => void save()} disabled={!result || busy}>
            {t('activities.share.download')}
          </Button>
        </>
      }
    >
      <span ref={iconRef} className="hidden" aria-hidden>
        <SportIcon sport={w.sport} size={24} strokeWidth={2.25} />
      </span>
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_18rem]">
        <div
          className="relative grid min-h-64 place-items-center overflow-hidden rounded-control border border-border p-3"
          // a checkerboard shows where the sticker is transparent
          style={{
            background:
              bg === 'sticker'
                ? 'repeating-conic-gradient(var(--surface-2) 0 25%, var(--surface) 0 50%) 50% / 20px 20px'
                : 'var(--surface-2)',
          }}
        >
          <canvas
            ref={preview}
            role="img"
            aria-label={t('activities.share.preview')}
            className="block h-auto max-h-[min(56vh,540px)] w-auto max-w-full rounded-[6px] shadow-card"
          />
          {busy && (
            <span className="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-surface px-2 py-1 text-xs text-fg-2 shadow-card">
              <Spinner size={14} />
              {t('activities.share.rendering')}
            </span>
          )}
        </div>
        <div className="grid content-start gap-4">
          <Field label={t('activities.share.format')} group>
            <SegmentedControl
              size="sm"
              label={t('activities.share.format')}
              value={format}
              onChange={setFormat}
              items={SHARE_FORMATS.map((f) => ({ value: f, label: t(`activities.share.formats.${f}`) }))}
            />
          </Field>
          <Field label={t('activities.share.background')} help={mapsOff && bg !== 'map' ? t('activities.share.mapOff') : undefined} group>
            <SegmentedControl
              size="sm"
              label={t('activities.share.background')}
              value={bg}
              onChange={setBackground}
              items={(hasRoute ? (['map', 'plain', 'sticker'] as const) : (['plain', 'sticker'] as const)).map((b) => ({
                value: b,
                label: t(`activities.share.backgrounds.${b}`),
              }))}
            />
          </Field>
          <Field label={t('activities.share.theme')} group>
            <SegmentedControl
              size="sm"
              label={t('activities.share.theme')}
              value={theme}
              onChange={setTheme}
              items={(['light', 'dark'] as const).map((v) => ({ value: v, label: t(`activities.share.themes.${v}`) }))}
            />
          </Field>
          <Field
            label={t('activities.share.values')}
            help={statKeys.length >= MAX_SHARE_STATS ? t('activities.share.valuesMax', { count: MAX_SHARE_STATS }) : undefined}
            group
          >
            <div className="flex flex-wrap gap-1.5">
              {availableStats.map((k) => {
                const on = statKeys.includes(k);
                return (
                  <span key={k} className={!on && statKeys.length >= MAX_SHARE_STATS ? 'pointer-events-none opacity-50' : undefined}>
                    <ToggleChip size="sm" icon={Plus} active={on} onChange={(v) => toggleStat(k, v)}>
                      {t(`activities.share.stats.${k}`)}
                    </ToggleChip>
                  </span>
                );
              })}
            </div>
          </Field>
          {availableCharts.length > 0 && (
            <Field
              label={t('activities.share.charts')}
              help={chartKeys.length ? undefined : t('activities.share.chartsHint')}
              group
            >
              <div className="flex flex-wrap gap-1.5">
                {availableCharts.map((k) => {
                  const on = chartKeys.includes(k);
                  return (
                    <span key={k} className={!on && chartKeys.length >= MAX_SHARE_CHARTS ? 'pointer-events-none opacity-50' : undefined}>
                      <ToggleChip size="sm" icon={LineChart} active={on} onChange={(v) => toggleChart(k, v)}>
                        {t(`activities.share.chartKinds.${k}`)}
                      </ToggleChip>
                    </span>
                  );
                })}
              </div>
            </Field>
          )}
          <div className="grid gap-2.5">
            {hasRoute && bg !== 'sticker' && (
              <Switch checked={show.route} onChange={(v) => setShow({ ...show, route: v })} label={t('activities.share.showRoute')} />
            )}
            <Switch checked={show.date} onChange={(v) => setShow({ ...show, date: v })} label={t('activities.share.showDate')} />
            {place && <Switch checked={show.place} onChange={(v) => setShow({ ...show, place: v })} label={t('activities.share.showPlace')} />}
            {zones.length > 0 && hasRoute && (
              <div className="grid gap-1">
                <Switch checked={privacy} onChange={setPrivacy} label={t('activities.share.privacy')} />
                <span className="pl-11 text-xs text-fg-3">{t('activities.share.privacyHint')}</span>
              </div>
            )}
          </div>
          {status && <p className="text-xs text-fg-3">{status}</p>}
        </div>
      </div>
    </Dialog>
  );
}
