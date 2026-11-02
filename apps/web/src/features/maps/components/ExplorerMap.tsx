import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { Popup, type LngLat } from 'maplibre-gl';
import type { MapsExplorerTile } from '@cadence/shared';
import { BaseMap, type Map as MapLibreMap } from '@/components/map/BaseMap';
import { fitTo } from '@/components/map/layers';
import { overlayColors } from '@/components/map/styles';
import { useChartTheme } from '@/components/charts/theme';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useResolvedTheme } from '@/lib/theme';
import '../maps.css';
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
  visitSteps,
  type ExplorerColorBy,
  type FirstBuckets,
} from '../lib/explorerLayers';
import type { BBox } from '../lib/home';
import type { HeatBase } from '../lib/heatmapLayers';

export interface ExplorerMapProps {
  className?: string;
  zoom: 14 | 17;
  tiles: MapsExplorerTile[];
  buckets: FirstBuckets;
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

/** Visited tiles on a map: fill by visits / first visit, max cluster outline, max square, optional detail tiles. */
export function ExplorerMap({
  className,
  zoom,
  tiles,
  buckets,
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
  const mapRef = useRef<MapLibreMap | null>(null);
  const [styleVersion, setStyleVersion] = useState(0);
  const chart = useChartTheme();
  const appTheme = useResolvedTheme();
  const darkBase = overlayColors(base, appTheme).darkBase;
  const colors = useMemo(
    () => explorerColors(colorBy, darkBase, chart.accent, chart.series[1]!),
    [colorBy, darkBase, chart.accent, chart.series],
  );
  const colorsRef = useRef(colors);
  colorsRef.current = colors;
  const steps = useMemo(() => visitSteps(Math.max(1, ...tiles.map((t) => t.visits))), [tiles]);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const onZoomRef = useRef(onZoomChange);
  onZoomRef.current = onZoomChange;

  const [picked, setPicked] = useState<{ i: number; lngLat: LngLat } | null>(null);
  const popupEl = useMemo(() => document.createElement('div'), []);
  const popupRef = useRef<Popup | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!picked) {
      popupRef.current?.remove();
      popupRef.current = null;
      return;
    }
    if (!popupRef.current) {
      const p = new Popup({ closeButton: true, maxWidth: '300px', offset: 6 }).setDOMContent(popupEl);
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
  useEffect(() => setPicked(null), [tiles, zoom]);

  // layers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleVersion === 0) return;
    ensureExplorerLayers(map, colorsRef.current, stepsRef.current);
    applyExplorerColors(map, colors, colorBy, steps);
  }, [styleVersion, colors, colorBy, steps]);

  const collection = useMemo(() => tilesCollection(tiles, buckets), [tiles, buckets]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleVersion === 0) return;
    ensureExplorerLayers(map, colorsRef.current, stepsRef.current);
    setTileData(map, zoom === 14 ? collection : null);
    setExplorerMode(map, zoom);
  }, [collection, zoom, styleVersion]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleVersion === 0) return;
    ensureExplorerLayers(map, colorsRef.current, stepsRef.current);
    setSquare(map, square, zoom);
    setNextTiles(map, zoom === 14 ? next : [], 14);
  }, [square, next, zoom, styleVersion]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleVersion === 0) return;
    ensureExplorerLayers(map, colorsRef.current, stepsRef.current);
    setDetailTilesInView(map, zoom === 17 ? detail : null);
  }, [detail, zoom, styleVersion]);

  const boundsKey = bounds ? bounds.join(',') : '';
  const first = useRef(true);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !bounds) return;
    if (first.current) {
      first.current = false;
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
        }}
        onStyleLoad={(map) => {
          mapRef.current = map;
          setStyleVersion((v) => v + 1);
        }}
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
      <div className="mt-1 text-xs text-fg-3">{t('maps.explorer.visitsCount', { count: tile.visits })}</div>
      <Link
        to={`/activities/${tile.workoutId}`}
        className="mt-1.5 inline-block text-xs font-medium text-accent-fg hover:underline"
      >
        {t('maps.explorer.openFirst')}
      </Link>
    </div>
  );
}
