import type { Map as MapLibreMap } from 'maplibre-gl';
import { featureCollection, lineFeature, pointFeature, setGeoJSON, type LngLat } from '@/components/map/layers';

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

/** What is drawn per item id: its coordinates and style. Start a new one after every style load (it removed the layers). */
export type LineOverlayState = Map<string, { lines: LngLat[][]; style: string } | { coord: LngLat | null; style: string }>;

const src = (id: string) => `lm-${id}`;

/** Same polylines: the same arrays (a new wrapper around unchanged parts counts as unchanged). */
const sameLines = (a: LngLat[][], b: LngLat[][]): boolean =>
  a === b || (a.length === b.length && a.every((part, i) => part === b[i]));

const sameCoord = (a: LngLat | null, b: LngLat | null): boolean =>
  a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);

/**
 * Brings the map's line and marker layers in line with `lines` and `markers`. A source gets new data only when the
 * item's coordinates changed and paint properties are set only when its style changed, so moving the hover marker of
 * the segment editor re-uploads one point instead of the whole route. Items no longer listed are removed. Sources and
 * layers are created per id (`lm-<id>`, `lm-<id>-casing`) on first use.
 */
export function syncLineOverlays(
  map: MapLibreMap,
  lines: MapLine[],
  markers: MapMarker[],
  drawn: LineOverlayState,
): void {
  const wanted = new Set<string>();
  const layout = { 'line-cap': 'round', 'line-join': 'round' } as const;
  for (const l of lines) {
    wanted.add(l.id);
    const s = src(l.id);
    const prev = drawn.get(l.id);
    if (!prev || !('lines' in prev) || !sameLines(prev.lines, l.lines))
      setGeoJSON(map, s, featureCollection(l.lines.filter((c) => c.length > 1).map((c) => lineFeature(c))));
    const width = l.width ?? 4;
    const opacity = l.opacity ?? 1;
    const style = [l.color, width, opacity, l.casing ?? '', l.dashed ? 'dashed' : ''].join('|');
    if (prev?.style !== style) {
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
    drawn.set(l.id, { lines: l.lines, style });
  }
  for (const m of markers) {
    wanted.add(m.id);
    const s = src(m.id);
    const prev = drawn.get(m.id);
    if (!prev || !('coord' in prev) || !sameCoord(prev.coord, m.coord))
      setGeoJSON(map, s, featureCollection(m.coord ? [pointFeature(m.coord)] : []));
    const style = [m.color, m.radius ?? 6, m.stroke ?? '#ffffff'].join('|');
    if (prev?.style !== style) {
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
    drawn.set(m.id, { coord: m.coord, style });
  }
  // drop what is no longer wanted
  for (const id of [...drawn.keys()]) {
    if (wanted.has(id)) continue;
    const s = src(id);
    for (const layer of [s, `${s}-casing`]) if (map.getLayer(layer)) map.removeLayer(layer);
    if (map.getSource(s)) map.removeSource(s);
    drawn.delete(id);
  }
}
