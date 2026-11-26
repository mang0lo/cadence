import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import type { LngLat } from 'maplibre-gl';
import type { MapsExplorerTile } from '@cadence/shared';
import { BaseMap, type Map as MapLibreMap } from '@/components/map/BaseMap';
import { overlayColors } from '@/components/map/styles';
import { useFitBounds, useMapOverlay, useMapPopup, useOverlayEffect } from '@/components/map/useMapOverlay';
import { useChartTheme } from '@/components/charts/theme';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useResolvedTheme } from '@/lib/theme';
import {
  ID,
  applyExplorerColors,
  ensureExplorerLayers,
  explorerColors,
  setDetailTilesInView,
  setExplorerMode,
  setNextTiles,
  setSquare,
  setTileData,
  tilesCollection,
  type ExplorerColorBy,
  type FirstBuckets,
} from '../lib/explorerLayers';
import { countVars } from '../lib/counts';
import type { BBox } from '../lib/home';
import type { HeatBase } from '../lib/heatmapLayers';

export interface ExplorerMapProps {
  className?: string;
  zoom: 14 | 17;
  tiles: MapsExplorerTile[];
  buckets: FirstBuckets;
  /** Visit-count buckets of the tiles (visitSteps), shared with the legend. */
  steps: number[];
  /** Visited zoom-17 tiles (keys), drawn for the current viewport only. */
  detail: Set<number> | null;
  square: { x: number; y: number; size: number } | null;
  /** Unvisited tiles that would extend the max square. */
  next: { x: number; y: number }[];
  colorBy: ExplorerColorBy;
  base: HeatBase;
  bounds: BBox | null;
  fitNonce?: number;
  /** Called with the map's zoom after every zoom change (the detail tiles need zoom ≥ 12). */
  onZoomChange?: (zoom: number) => void;
  children?: ReactNode;
}

const POPUP = { closeButton: true, maxWidth: '300px', offset: 6 } as const;

/** Visited tiles on a map: fill by visits / first visit, max cluster outline, max square, optional detail tiles. */
export function ExplorerMap({
  className,
  zoom,
  tiles,
  buckets,
  steps,
  detail,
  square,
  next,
  colorBy,
  base,
  bounds,
  fitNonce = 0,
  onZoomChange,
  children,
}: ExplorerMapProps) {
  const chart = useChartTheme();
  const appTheme = useResolvedTheme();
  const darkBase = overlayColors(base, appTheme).darkBase;
  const colors = useMemo(
    () => explorerColors(colorBy, darkBase, chart.accent, chart.series[1]!),
    [colorBy, darkBase, chart.accent, chart.series],
  );
  const colorsRef = useRef(colors);
  colorsRef.current = colors;
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const onZoomRef = useRef(onZoomChange);
  onZoomRef.current = onZoomChange;

  const [picked, setPicked] = useState<{ i: number; lngLat: LngLat } | null>(null);
  const bindEvents = (map: MapLibreMap) => {
    map.on('click', (e) => {
      if (zoomRef.current !== 14 || !map.getLayer(ID.fill)) return;
      const f = map.queryRenderedFeatures(e.point, { layers: [ID.fill] })[0];
      const i = f?.properties?.i;
      setPicked(typeof i === 'number' ? { i, lngLat: e.lngLat } : null);
    });
    map.on('mousemove', (e) => {
      const over =
        zoomRef.current === 14 &&
        map.getLayer(ID.fill) &&
        map.queryRenderedFeatures(e.point, { layers: [ID.fill] }).length > 0;
      map.getCanvas().style.cursor = over ? 'pointer' : '';
    });
    map.on('moveend', () => {
      if (zoomRef.current === 17) setDetailTilesInView(map, detailRef.current);
      onZoomRef.current?.(map.getZoom());
    });
  };
  const overlay = useMapOverlay({ onReady: bindEvents });
  const popupEl = useMapPopup(overlay.mapRef, picked?.lngLat ?? null, () => setPicked(null), POPUP);
  useEffect(() => setPicked(null), [tiles, zoom]);

  // layers: only while the style is loaded (a theme or basemap switch replaces it), and again after every style load
  useOverlayEffect(
    overlay,
    (map) => {
      ensureExplorerLayers(map, colorsRef.current, stepsRef.current);
      applyExplorerColors(map, colors, colorBy, steps);
    },
    [colors, colorBy, steps],
  );

  const collection = useMemo(() => tilesCollection(tiles, buckets), [tiles, buckets]);
  useOverlayEffect(
    overlay,
    (map) => {
      ensureExplorerLayers(map, colorsRef.current, stepsRef.current);
      setTileData(map, zoom === 14 ? collection : null);
      setExplorerMode(map, zoom);
    },
    [collection, zoom],
  );

  useOverlayEffect(
    overlay,
    (map) => {
      ensureExplorerLayers(map, colorsRef.current, stepsRef.current);
      setSquare(map, square, zoom);
      setNextTiles(map, zoom === 14 ? next : [], 14);
    },
    [square, next, zoom],
  );

  useOverlayEffect(
    overlay,
    (map) => {
      ensureExplorerLayers(map, colorsRef.current, stepsRef.current);
      setDetailTilesInView(map, zoom === 17 ? detail : null);
    },
    [detail, zoom],
  );

  useFitBounds(overlay.mapRef, bounds, fitNonce, 48);

  return (
    <>
      <BaseMap
        className={className}
        styleKey={base}
        bounds={bounds}
        padding={48}
        switcher={false}
        {...overlay.bind}
      >
        {children}
      </BaseMap>
      {picked && tiles[picked.i] && createPortal(<TilePopup tile={tiles[picked.i]!} />, popupEl)}
    </>
  );
}

function TilePopup({ tile }: { tile: MapsExplorerTile }) {
  const t = useT();
  const fmt = useFormat();
  return (
    <div className="min-w-44 text-sm">
      <div className="text-xs font-medium text-fg-3">{t('maps.explorer.firstVisit')}</div>
      <div className="font-semibold text-fg">{fmt.date(tile.firstTs, tile.tzMin, 'day')}</div>
      <div className="mt-1 text-xs text-fg-3">{t('maps.explorer.visitsCount', countVars(fmt, tile.visits))}</div>
      <Link
        to={`/activities/${tile.workoutId}`}
        className="mt-1.5 inline-block text-xs font-medium text-accent-fg hover:underline"
      >
        {t('maps.explorer.openFirst')}
      </Link>
    </div>
  );
}
