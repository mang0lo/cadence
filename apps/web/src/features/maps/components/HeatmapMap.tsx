import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { Popup, type LngLat } from 'maplibre-gl';
import type { MapsHeatmapActivity } from '@cadence/shared';
import { workoutTitle } from '@cadence/shared';
import { BaseMap, type Map as MapLibreMap } from '@/components/map/BaseMap';
import { fitTo } from '@/components/map/layers';
import { overlayColors } from '@/components/map/styles';
import { useFormat } from '@/lib/format';
import { useI18n, useT } from '@/lib/i18n';
import { sportColorVar, useSportLabel } from '@/lib/sports';
import { useResolvedTheme } from '@/lib/theme';
import {
  LAYER,
  applyHeatPalette,
  densityPoints,
  ensureHeatLayers,
  heatPalette,
  linesCollection,
  setDensityIntensity,
  setDensityVisible,
  setHeadLine,
  setLapseFilter,
  setLinesData,
  setPointsData,
  type HeatBase,
  type HeatLine,
  type HeatTheme,
} from '../lib/heatmapLayers';

export interface HeatmapLapse {
  /** Number of finished activities (chronological). */
  done: number;
  /** The activity being drawn right now (partial polyline, lon/lat). */
  head: [number, number][] | null;
}

export interface HeatmapMapProps {
  className?: string;
  activities: MapsHeatmapActivity[];
  lines: HeatLine[];
  theme: HeatTheme;
  base: HeatBase;
  density: boolean;
  bounds: [number, number, number, number] | null;
  /** Time-lapse state; `null` shows every activity. */
  lapse: HeatmapLapse | null;
  /** Bump to fit the data again. */
  fitNonce?: number;
  children?: ReactNode;
}

/** Heatmap of all routes: stacked, low-opacity, blurred strokes + optional point density + click popups. */
export function HeatmapMap({
  className,
  activities,
  lines,
  theme,
  base,
  density,
  bounds,
  lapse,
  fitNonce = 0,
  children,
}: HeatmapMapProps) {
  const mapRef = useRef<MapLibreMap | null>(null);
  const [styleVersion, setStyleVersion] = useState(0);
  const appTheme = useResolvedTheme();
  const darkBase = overlayColors(base, appTheme).darkBase;
  const palette = useMemo(() => heatPalette(theme, darkBase), [theme, darkBase]);
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  const lapseActive = lapse !== null;
  const lapseActiveRef = useRef(lapseActive);
  lapseActiveRef.current = lapseActive;

  const geo = useMemo(() => linesCollection(lines), [lines]);
  const byId = useMemo(() => new Map(activities.map((a) => [a.id, a])), [activities]);

  // --- popup (React content rendered into the MapLibre popup through a portal) ---
  const [picked, setPicked] = useState<{ ids: number[]; lngLat: LngLat } | null>(null);
  const popupEl = useMemo(() => document.createElement('div'), []);
  const popupRef = useRef<Popup | null>(null);

  const bindEvents = (map: MapLibreMap) => {
    const hit = (point: { x: number; y: number }) =>
      map.getLayer(LAYER.hit)
        ? map.queryRenderedFeatures([point.x, point.y] as never, { layers: [LAYER.hit] })
        : [];
    map.on('click', (e) => {
      if (lapseActiveRef.current) return;
      const ids = [...new Set(hit(e.point).map((f) => Number(f.properties?.id)))].filter(Number.isFinite);
      setPicked(ids.length ? { ids, lngLat: e.lngLat } : null);
    });
    map.on('mousemove', (e) => {
      const over = !lapseActiveRef.current && hit(e.point).length > 0;
      map.getCanvas().style.cursor = over ? 'pointer' : '';
    });
  };

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!picked) {
      popupRef.current?.remove();
      popupRef.current = null;
      return;
    }
    if (!popupRef.current) {
      const p = new Popup({ closeButton: true, maxWidth: '340px', offset: 6 }).setDOMContent(popupEl);
      p.on('close', () => {
        if (popupRef.current === p) {
          popupRef.current = null;
          setPicked(null);
        }
      });
      popupRef.current = p;
      p.setLngLat(picked.lngLat).addTo(map);
    } else popupRef.current.setLngLat(picked.lngLat);
  }, [picked, popupEl]);

  // a new data set invalidates the popup
  useEffect(() => setPicked(null), [activities]);
  useEffect(() => {
    if (lapseActive) setPicked(null);
  }, [lapseActive]);

  // --- layers & data ---
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleVersion === 0 || !map.isStyleLoaded()) return;
    ensureHeatLayers(map, paletteRef.current);
    applyHeatPalette(map, palette);
  }, [styleVersion, palette]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleVersion === 0) return;
    ensureHeatLayers(map, paletteRef.current);
    setLinesData(map, geo);
  }, [geo, styleVersion]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleVersion === 0) return;
    ensureHeatLayers(map, paletteRef.current);
    if (density) {
      const { points, maxPasses } = densityPoints(lines);
      setPointsData(map, points);
      setDensityIntensity(map, maxPasses);
    }
    setDensityVisible(map, density);
  }, [density, lines, styleVersion]);

  const done = lapse ? lapse.done : null;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleVersion === 0) return;
    ensureHeatLayers(map, paletteRef.current);
    setLapseFilter(map, done);
  }, [done, styleVersion, geo]);

  const head = lapse?.head ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleVersion === 0) return;
    ensureHeatLayers(map, paletteRef.current);
    setHeadLine(map, head);
  }, [head, styleVersion]);

  const boundsKey = bounds ? bounds.join(',') : '';
  const first = useRef(true);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !bounds) return;
    if (first.current) {
      first.current = false; // BaseMap already starts with these bounds
      return;
    }
    fitTo(map, bounds, 48, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey, fitNonce]);

  return (
    <>
      <BaseMap
        className={className}
        styleKey={base}
        bounds={bounds}
        padding={48}
        switcher={false}
        onReady={(map) => {
          mapRef.current = map;
          bindEvents(map);
        }}
        onStyleLoad={(map) => {
          mapRef.current = map;
          setStyleVersion((v) => v + 1);
        }}
      >
        {children}
      </BaseMap>
      {picked && createPortal(<PopupList ids={picked.ids} byId={byId} />, popupEl)}
    </>
  );
}

/** Content of the click popup: the activities whose route runs through the clicked spot. */
function PopupList({ ids, byId }: { ids: number[]; byId: Map<number, MapsHeatmapActivity> }) {
  const t = useT();
  const { lang } = useI18n();
  const fmt = useFormat();
  const sportLabel = useSportLabel();
  const items = ids
    .map((id) => byId.get(id))
    .filter((a): a is MapsHeatmapActivity => !!a)
    .sort((a, b) => b.startTs - a.startTs);
  const shown = items.slice(0, 12);
  return (
    <div className="min-w-48 max-w-80 text-sm">
      <ul className="max-h-60 space-y-2 overflow-y-auto pr-1 scrollbar-thin">
        {shown.map((a) => (
          <li key={a.id}>
            <Link to={`/activities/${a.id}`} className="group flex items-start gap-2">
              <span
                className="mt-1.5 size-2 shrink-0 rounded-full"
                style={{ background: sportColorVar(a.sport) }}
                aria-hidden
              />
              <span className="min-w-0">
                <span className="block truncate font-medium text-fg group-hover:text-accent-fg">
                  {workoutTitle(a, lang)}
                </span>
                <span className="block text-xs text-fg-3">
                  {fmt.date(a.startTs, a.tzMin, 'day')} · {sportLabel(a.sport)}
                  {a.distanceM ? ` · ${fmt.distance(a.distanceM)}` : ''}
                  {a.durationS ? ` · ${fmt.durationShort(a.durationS)}` : ''}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {items.length > shown.length && (
        <div className="mt-2 text-xs text-fg-3">
          {t('maps.heatmap.more', { count: items.length - shown.length })}
        </div>
      )}
    </div>
  );
}
