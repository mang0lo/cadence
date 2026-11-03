import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Download, Share2 } from 'lucide-react';
import { sportInfo, trackParts, workoutTitle, type WorkoutDetail } from '@cadence/shared';
import { thumbnailBasemap } from '@/components/map/tiles';
import { Button, Dialog, Field, SegmentedControl, Spinner, Switch } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { isNativeShell, postNative } from '@/lib/native';
import { activityPlace } from '@/lib/places';
import { decodePolylineParts } from '@/lib/polyline';
import { useSettings } from '@/lib/settings';
import { SportIcon, sportLabel, sportSlot } from '@/lib/sports';
import { useStoredState } from '@/lib/storage';
import { useResolvedTheme } from '@/lib/theme';
import { dayKey } from '@/lib/time';
import { useStreams } from '../../api';
import { isPaceSport, keyStats, shortDistanceParts } from '../../lib/display';
import {
  SHARE_FORMATS,
  hidePrivacyZones,
  shareFileName,
  type LatLon,
  type ShareBackground,
  type ShareFormat,
  type ShareTheme,
} from '../../lib/share';
import { blobBase64, canvasBlob, renderShareImage, type ShareResult, type ShareStat } from '../../lib/shareImage';
import { haversine, simplifyIndices } from '../../lib/streams';

/** The route at full resolution from the streams (simplified to below a pixel), else the stored polyline. */
function useRouteParts(w: WorkoutDetail): LatLon[][] {
  const streams = useStreams(w.id);
  return useMemo(() => {
    const s = streams.data;
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
  }, [streams.data, w.polyline, w.bounds]);
}

/** Dialog with a live preview of the share image and its options; saves, shares or copies the PNG. */
export default function ShareDialog({ w, onClose }: { w: WorkoutDetail; onClose: () => void }) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const { settings } = useSettings();
  const resolved = useResolvedTheme();
  const zones = settings.privacyZones ?? [];
  const mapsOff = settings.thumbnailMaps === false;
  const route = useRouteParts(w);
  const hasRoute = route.some((p) => p.length >= 2);

  const [format, setFormat] = useStoredState<ShareFormat>('activities.shareFormat', 'square');
  const [background, setBackground] = useState<ShareBackground>(mapsOff || !w.hasRoute ? 'plain' : 'map');
  const [theme, setTheme] = useState<ShareTheme>(resolved);
  const [privacy, setPrivacy] = useState(true);
  const [showHr, setShowHr] = useState(false);
  const [showPower, setShowPower] = useState(false);
  const bg: ShareBackground = !hasRoute && background === 'map' ? 'plain' : background;

  const priv = useMemo(() => (privacy && zones.length && hasRoute ? hidePrivacyZones(route, zones) : null), [privacy, zones, hasRoute, route]);
  const parts = priv ? priv.parts : route;

  const info = sportInfo(w.sport);
  const distanceSport = info.distance && (w.distanceM ?? 0) > 0;
  const stats = useMemo<ShareStat[]>(() => {
    if (!distanceSport) return keyStats(w, fmt, t, 4).map(({ label, value, unit }) => ({ label, value, unit }));
    const out: ShareStat[] = [];
    const d = w.sport === 'swim' ? shortDistanceParts(w.distanceM!, fmt) : fmt.distanceParts(w.distanceM);
    out.push({ label: t('common.distance'), ...d });
    out.push({ label: t('common.movingTime'), value: fmt.duration(w.movingS ?? w.durationS) });
    if (info.speedMode !== 'none' && w.avgSpeed)
      out.push({ label: isPaceSport(w.sport) ? t('common.pace') : t('common.speed'), ...fmt.paceParts(w.avgSpeed, w.sport) });
    if (w.hasRoute && (w.elevationGainM ?? 0) >= 1) out.push({ label: t('common.elevationGain'), ...fmt.elevationParts(w.elevationGainM) });
    if (showHr && w.avgHr) out.push({ label: t('common.avgHr'), value: fmt.int(w.avgHr), unit: 'bpm' });
    if (showPower && w.avgPower) out.push({ label: t('activities.stats.avgPower'), value: fmt.int(w.avgPower), unit: 'W' });
    return out;
  }, [w, fmt, t, info.speedMode, distanceSport, showHr, showPower]);

  const title = workoutTitle(w, lang);
  const place = activityPlace(w, lang);
  const subtitle = [fmt.date(w.startTs, w.tzMin, 'day'), fmt.time(w.startTs, w.tzMin), place].filter(Boolean).join(' · ');
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
        parts: bg === 'sticker' ? [] : parts,
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
  }, [title, subtitle, w.sport, lang, stats, bg, parts, priv, t, format, theme, settings.mapStyle]);

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
      const blob = await canvasBlob(result.canvas);
      // WKWebView does not download blob: links reliably — the Mac app writes the file itself
      if (isNativeShell()) {
        postNative('saveFile', { filename, base64: await blobBase64(blob) });
        setDone('saved');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
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
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_16rem]">
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
          {(zones.length > 0 && hasRoute) || (distanceSport && (w.avgHr || w.avgPower)) ? (
            <div className="grid gap-2.5">
              {zones.length > 0 && hasRoute && (
                <div className="grid gap-1">
                  <Switch checked={privacy} onChange={setPrivacy} label={t('activities.share.privacy')} />
                  <span className="pl-11 text-xs text-fg-3">{t('activities.share.privacyHint')}</span>
                </div>
              )}
              {distanceSport && !!w.avgHr && <Switch checked={showHr} onChange={setShowHr} label={t('activities.share.showHr')} />}
              {distanceSport && !!w.avgPower && (
                <Switch checked={showPower} onChange={setShowPower} label={t('activities.share.showPower')} />
              )}
            </div>
          ) : null}
          {status && <p className="text-xs text-fg-3">{status}</p>}
        </div>
      </div>
    </Dialog>
  );
}
