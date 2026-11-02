import type { Feature, FeatureCollection, GeoJSON, Geometry, LineString, Point } from 'geojson';
import type { GeoJSONSource, LngLatBoundsLike, Map, ExpressionSpecification } from 'maplibre-gl';

export type LngLat = [number, number];

export function lineFeature(coords: LngLat[], properties: Record<string, unknown> = {}): Feature<LineString> {
  return { type: 'Feature', properties, geometry: { type: 'LineString', coordinates: coords } };
}

export function pointFeature(coord: LngLat, properties: Record<string, unknown> = {}): Feature<Point> {
  return { type: 'Feature', properties, geometry: { type: 'Point', coordinates: coord } };
}

export function featureCollection<G extends Geometry>(features: Feature<G>[]): FeatureCollection<G> {
  return { type: 'FeatureCollection', features };
}

/** Add a GeoJSON source, or replace its data when it already exists (cheap enough for animation). */
export function setGeoJSON(map: Map, id: string, data: GeoJSON, lineMetrics = false): void {
  const src = map.getSource(id) as GeoJSONSource | undefined;
  if (src) src.setData(data);
  else map.addSource(id, { type: 'geojson', data, lineMetrics });
}

/** A route line with a contrasting casing underneath (reads on any basemap). */
export function addRouteLayers(
  map: Map,
  id: string,
  opts: { color: string; casing: string; width?: number; opacity?: number; gradient?: ExpressionSpecification; beforeId?: string },
): void {
  const width = opts.width ?? 4;
  if (!map.getLayer(`${id}-casing`)) {
    map.addLayer(
      {
        id: `${id}-casing`,
        type: 'line',
        source: id,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': opts.casing, 'line-width': width + 3, 'line-opacity': opts.opacity ?? 1 },
      },
      opts.beforeId,
    );
  }
  if (!map.getLayer(id)) {
    map.addLayer(
      {
        id,
        type: 'line',
        source: id,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': opts.color,
          'line-width': width,
          'line-opacity': opts.opacity ?? 1,
          ...(opts.gradient ? { 'line-gradient': opts.gradient } : {}),
        },
      },
      opts.beforeId,
    );
  }
}

/**
 * line-gradient expression from (fraction 0..1 along the line, color) stops — for routes colored by
 * pace, heart rate or elevation. Requires the source to be created with lineMetrics = true.
 */
export function gradientExpression(stops: [number, string][]): ExpressionSpecification {
  const clean: [number, string][] = [];
  let last = -1;
  for (const [f, c] of stops) {
    const v = Math.min(1, Math.max(0, f));
    if (v > last) {
      clean.push([v, c]);
      last = v;
    }
  }
  if (clean.length < 2) return ['literal', clean[0]?.[1] ?? '#e8590c'] as unknown as ExpressionSpecification;
  return ['interpolate', ['linear'], ['line-progress'], ...clean.flat()] as unknown as ExpressionSpecification;
}

/** A start/end or position marker as a circle layer. */
export function addCircleLayer(
  map: Map,
  id: string,
  opts: { color: string; radius?: number; stroke?: string; strokeWidth?: number },
): void {
  if (map.getLayer(id)) return;
  map.addLayer({
    id,
    type: 'circle',
    source: id,
    paint: {
      'circle-color': opts.color,
      'circle-radius': opts.radius ?? 6,
      'circle-stroke-color': opts.stroke ?? '#ffffff',
      'circle-stroke-width': opts.strokeWidth ?? 2,
      'circle-pitch-alignment': 'map',
    },
  });
}

export function fitTo(map: Map, bounds: [number, number, number, number], padding = 40, animate = false): void {
  map.fitBounds(bounds as LngLatBoundsLike, { padding, animate, maxZoom: 16 });
}
