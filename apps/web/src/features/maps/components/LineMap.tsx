import { useMemo, useRef, type ReactNode } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { BaseMap } from '@/components/map/BaseMap';
import { featureCollection, lineFeature, pointFeature, setGeoJSON, type LngLat } from '@/components/map/layers';
import { useFitBounds, useMapOverlay, useOverlayEffect } from '@/components/map/useMapOverlay';
import type { BBox } from '../lib/home';

export interface MapLine {
  id: string;
  /** One or more polylines ([lon, lat]) drawn with the same style. */
  lines: LngLat[][];
  color: string;
  width?: number;
  opacity?: number;
  /** Contrasting outline underneath (reads on any basemap). */
  casing?: string;
  dashed?: boolean;
}

export interface MapMarker {
  id: string;
  coord: LngLat | null;
  color: string;
  stroke?: string;
  radius?: number;
}

export interface LineMapProps {
  className?: string;
  lines: MapLine[];
  markers?: MapMarker[];
  bounds: BBox | null;
  /** Bump to fit the bounds again. */
  fitNonce?: number;
  padding?: number;
  /** Built-in basemap / 3D switcher of BaseMap (default on). */
  switcher?: boolean;
  onReady?: (map: MapLibreMap) => void;
  children?: ReactNode;
}

const src = (id: string) => `lm-${id}`;

/**
 * A map that draws a handful of styled polylines and point markers (route detail, segment views). Sources and layers
 * are created per id and kept in sync with the props; they are re-created after every basemap style switch.
 */
export function LineMap({
  className,
  lines,
  markers = [],
  bounds,
  fitNonce = 0,
  padding = 48,
  switcher = true,
  onReady,
  children,
}: LineMapProps) {
  const known = useRef(new Set<string>());
  const overlay = useMapOverlay({
    onReady,
    onStyleLoad: () => {
      known.current = new Set(); // a new style starts without our layers
    },
  });

  // only while the style is loaded (a theme or basemap switch replaces it), and again after every style load
  useOverlayEffect(overlay, (map) => {
    const wanted = new Set<string>();
    for (const l of lines) {
      wanted.add(l.id);
      const s = src(l.id);
      const data = featureCollection(l.lines.filter((c) => c.length > 1).map((c) => lineFeature(c)));
      setGeoJSON(map, s, data);
      const layout = { 'line-cap': 'round', 'line-join': 'round' } as const;
      const width = l.width ?? 4;
      const opacity = l.opacity ?? 1;
      if (l.casing) {
        if (!map.getLayer(`${s}-casing`))
          map.addLayer({
            id: `${s}-casing`,
            type: 'line',
            source: s,
            layout,
            paint: { 'line-color': l.casing, 'line-width': width + 3 },
          });
        map.setPaintProperty(`${s}-casing`, 'line-color', l.casing);
        map.setPaintProperty(`${s}-casing`, 'line-width', width + 3);
        map.setPaintProperty(`${s}-casing`, 'line-opacity', opacity);
      }
      if (!map.getLayer(s))
        map.addLayer({
          id: s,
          type: 'line',
          source: s,
          layout,
          paint: { 'line-color': l.color, 'line-width': width },
        });
      map.setPaintProperty(s, 'line-color', l.color);
      map.setPaintProperty(s, 'line-width', width);
      map.setPaintProperty(s, 'line-opacity', opacity);
      if (l.dashed) map.setPaintProperty(s, 'line-dasharray', [2, 1.5]);
    }
    for (const m of markers) {
      wanted.add(m.id);
      const s = src(m.id);
      setGeoJSON(map, s, featureCollection(m.coord ? [pointFeature(m.coord)] : []));
      if (!map.getLayer(s)) {
        map.addLayer({
          id: s,
          type: 'circle',
          source: s,
          paint: {
            'circle-color': m.color,
            'circle-radius': m.radius ?? 6,
            'circle-stroke-color': m.stroke ?? '#ffffff',
            'circle-stroke-width': 2,
          },
        });
      }
      map.setPaintProperty(s, 'circle-color', m.color);
      map.setPaintProperty(s, 'circle-radius', m.radius ?? 6);
      map.setPaintProperty(s, 'circle-stroke-color', m.stroke ?? '#ffffff');
    }
    // drop what is no longer wanted
    for (const id of known.current) {
      if (wanted.has(id)) continue;
      const s = src(id);
      for (const layer of [s, `${s}-casing`]) if (map.getLayer(layer)) map.removeLayer(layer);
      if (map.getSource(s)) map.removeSource(s);
    }
    known.current = wanted;
  }, [lines, markers]);

  useFitBounds(overlay.mapRef, bounds, fitNonce, padding);

  const stable = useMemo(() => ({ bounds }), [bounds]);
  return (
    <BaseMap
      className={className}
      bounds={stable.bounds}
      padding={padding}
      switcher={switcher}
      {...overlay.bind}
    >
      {children}
    </BaseMap>
  );
}
