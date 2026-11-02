import type { Feature, FeatureCollection, Polygon } from 'geojson';
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { lonLatToTile, tileBounds, tileKey, type MapsExplorerTile } from '@cadence/shared';

export type ExplorerColorBy = 'visits' | 'first';

/**
 * Sequential ramps (copies of the --seq-* / --seqb-* tokens): the tile fill depends on the BASEMAP being dark or light,
 * not on the app theme, so the ramp is picked here instead of from the chart theme.
 */
export const RAMPS = {
  orange: {
    dark: ['#9a4212', '#c4531a', '#ea6a1f', '#fb9a50', '#ffc996'],
    light: ['#fb923c', '#f2711c', '#d9480f', '#a8380c', '#7c2d12'],
  },
  blue: {
    dark: ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4'],
    light: ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281'],
  },
} as const;

export function explorerColors(
  colorBy: ExplorerColorBy,
  darkBase: boolean,
  accent: string,
  nextColor: string,
): ExplorerColors {
  const ramp = (colorBy === 'visits' ? RAMPS.orange : RAMPS.blue)[darkBase ? 'dark' : 'light'];
  return {
    ramp: [...ramp],
    detail: accent,
    outline: darkBase ? 'rgba(255,255,255,0.38)' : 'rgba(20,20,20,0.35)',
    cluster: darkBase ? '#ffffff' : '#0b0b0b',
    square: accent,
    next: nextColor,
  };
}

export interface ExplorerColors {
  /** Five sequential steps for the tile fill. */
  ramp: string[];
  /** Fill of the zoom-17 detail tiles. */
  detail: string;
  outline: string;
  cluster: string;
  square: string;
  next: string;
}

/**
 * Lower bounds of the 2nd..5th visit-count bucket: geometric steps up to the busiest tile, so a tile visited 3 times and
 * one visited 300 times both stay distinguishable (e.g. max 47 → 1 | 2–4 | 5–9 | 10–21 | 22+).
 */
export function visitSteps(maxVisits: number): number[] {
  const steps: number[] = [];
  let prev = 1;
  for (let i = 1; i <= 4; i++) {
    prev = Math.max(prev + 1, Math.round(Math.max(1, maxVisits) ** (i / 5)));
    steps.push(prev);
  }
  return steps;
}

/** Legend labels of the five visit buckets. */
export function visitLabels(steps: number[]): string[] {
  return [
    steps[0] === 2 ? '1' : `1–${steps[0]! - 1}`,
    ...steps.map((s, i) => {
      if (i === steps.length - 1) return `${s}+`;
      const hi = steps[i + 1]! - 1;
      return hi === s ? String(s) : `${s}–${hi}`;
    }),
  ];
}

export const tilePolygon = (x: number, y: number, z: number, w = 1, h = 1): Polygon => {
  const [minLon, minLat, maxLon, maxLat] = tileBounds(x, y, z, w, h);
  return {
    type: 'Polygon',
    coordinates: [
      [
        [minLon, maxLat],
        [maxLon, maxLat],
        [maxLon, minLat],
        [minLon, minLat],
        [minLon, maxLat],
      ],
    ],
  };
};

const empty: FeatureCollection<Polygon> = { type: 'FeatureCollection', features: [] };

export interface FirstBuckets {
  /** Bucket index 0..4 per tile (same order as the tiles array). */
  index: number[];
  /** [first, last] first-visit timestamp (+ offset) of every bucket, for the legend. */
  ranges: { fromTs: number; fromTz: number; toTs: number; toTz: number }[];
}

/** Five equally populated buckets of the first-visit time (0 = oldest, 4 = newest). */
export function firstVisitBuckets(tiles: MapsExplorerTile[]): FirstBuckets {
  const order = tiles.map((_, i) => i).sort((a, b) => tiles[a]!.firstTs - tiles[b]!.firstTs);
  const index = new Array<number>(tiles.length).fill(0);
  const n = tiles.length;
  const ranges: FirstBuckets['ranges'] = [];
  const buckets = Math.min(5, Math.max(1, n));
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * n) / buckets);
    const to = Math.floor(((b + 1) * n) / buckets) - 1;
    if (to < from) continue;
    for (let k = from; k <= to; k++) index[order[k]!] = b;
    const a = tiles[order[from]!]!;
    const z = tiles[order[to]!]!;
    ranges.push({ fromTs: a.firstTs, fromTz: a.tzMin, toTs: z.firstTs, toTz: z.tzMin });
  }
  return { index, ranges };
}

export function tilesCollection(
  tiles: MapsExplorerTile[],
  buckets: FirstBuckets,
  z = 14,
): FeatureCollection<Polygon> {
  return {
    type: 'FeatureCollection',
    features: tiles.map((t, i): Feature<Polygon> => ({
      type: 'Feature',
      properties: {
        i,
        visits: t.visits,
        fb: buckets.index[i] ?? 0,
        cluster: t.cluster,
        interior: t.interior,
      },
      geometry: tilePolygon(t.x, t.y, z),
    })),
  };
}

export const ID = {
  fill: 'ex-fill',
  line: 'ex-line',
  cluster: 'ex-cluster',
  detailFill: 'ex17-fill',
  detailLine: 'ex17-line',
  square: 'ex-square',
  next: 'ex-next',
} as const;
const SRC = { tiles: 'ex-tiles', detail: 'ex17', square: 'ex-square', next: 'ex-next' } as const;

function fillExpression(colorBy: ExplorerColorBy, ramp: string[], steps: number[]): ExpressionSpecification {
  if (colorBy === 'visits') {
    return [
      'step',
      ['get', 'visits'],
      ramp[0],
      steps[0],
      ramp[1],
      steps[1],
      ramp[2],
      steps[2],
      ramp[3],
      steps[3],
      ramp[4],
    ] as unknown as ExpressionSpecification;
  }
  return [
    'step',
    ['get', 'fb'],
    ramp[0],
    1,
    ramp[1],
    2,
    ramp[2],
    3,
    ramp[3],
    4,
    ramp[4],
  ] as unknown as ExpressionSpecification;
}

/** Create sources and layers (idempotent – call again after every basemap style switch). */
export function ensureExplorerLayers(map: MapLibreMap, c: ExplorerColors, steps: number[]): void {
  const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  for (const id of Object.values(SRC))
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: empty });
  const add = (spec: Parameters<MapLibreMap['addLayer']>[0]) => {
    if (!map.getLayer(spec.id)) map.addLayer(spec, before);
  };
  add({
    id: ID.fill,
    type: 'fill',
    source: SRC.tiles,
    paint: { 'fill-color': fillExpression('visits', c.ramp, steps), 'fill-opacity': 0.55 },
  });
  add({
    id: ID.line,
    type: 'line',
    source: SRC.tiles,
    paint: { 'line-color': c.outline, 'line-width': 1 },
  });
  add({
    id: ID.cluster,
    type: 'line',
    source: SRC.tiles,
    filter: ['==', ['get', 'cluster'], true],
    paint: { 'line-color': c.cluster, 'line-width': 2.2 },
  });
  add({
    id: ID.detailFill,
    type: 'fill',
    source: SRC.detail,
    paint: { 'fill-color': c.detail, 'fill-opacity': 0.5 },
  });
  add({
    id: ID.detailLine,
    type: 'line',
    source: SRC.detail,
    paint: { 'line-color': c.outline, 'line-width': 0.6 },
  });
  add({
    id: ID.next,
    type: 'line',
    source: SRC.next,
    paint: { 'line-color': c.next, 'line-width': 2, 'line-dasharray': [2, 1.5] },
  });
  add({
    id: ID.square,
    type: 'line',
    source: SRC.square,
    layout: { 'line-join': 'round' },
    paint: { 'line-color': c.square, 'line-width': 3.5 },
  });
}

export function applyExplorerColors(
  map: MapLibreMap,
  c: ExplorerColors,
  colorBy: ExplorerColorBy,
  steps: number[],
): void {
  if (!map.getLayer(ID.fill)) return;
  map.setPaintProperty(ID.fill, 'fill-color', fillExpression(colorBy, c.ramp, steps));
  map.setPaintProperty(ID.line, 'line-color', c.outline);
  map.setPaintProperty(ID.cluster, 'line-color', c.cluster);
  map.setPaintProperty(ID.detailFill, 'fill-color', c.detail);
  map.setPaintProperty(ID.detailLine, 'line-color', c.outline);
  map.setPaintProperty(ID.next, 'line-color', c.next);
  map.setPaintProperty(ID.square, 'line-color', c.square);
}

const setData = (map: MapLibreMap, id: string, data: FeatureCollection) =>
  (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);

export const setTileData = (map: MapLibreMap, fc: FeatureCollection<Polygon> | null) =>
  setData(map, SRC.tiles, fc ?? empty);

export function setSquare(
  map: MapLibreMap,
  sq: { x: number; y: number; size: number } | null,
  z: number,
): void {
  setData(map, SRC.square, {
    type: 'FeatureCollection',
    features: sq
      ? [{ type: 'Feature', properties: {}, geometry: tilePolygon(sq.x, sq.y, z, sq.size, sq.size) }]
      : [],
  });
}

export function setNextTiles(map: MapLibreMap, tiles: { x: number; y: number }[], z: number): void {
  setData(map, SRC.next, {
    type: 'FeatureCollection',
    features: tiles.map((t) => ({ type: 'Feature', properties: {}, geometry: tilePolygon(t.x, t.y, z) })),
  });
}

/** Zoom-17 tiles are only drawn while the map shows them at a useful size. */
export const DETAIL_MIN_ZOOM = 12;
const DETAIL_MAX_FEATURES = 25_000;

/** Polygons of the visited detail tiles inside the current viewport. */
export function setDetailTilesInView(map: MapLibreMap, visited: Set<number> | null): void {
  if (!visited || map.getZoom() < DETAIL_MIN_ZOOM) {
    setData(map, SRC.detail, empty);
    return;
  }
  const b = map.getBounds();
  const [x0, y0] = lonLatToTile(b.getNorth(), b.getWest(), 17);
  const [x1, y1] = lonLatToTile(b.getSouth(), b.getEast(), 17);
  const features: Feature<Polygon>[] = [];
  for (let y = Math.floor(y0); y <= Math.floor(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.floor(x1); x++) {
      if (visited.has(tileKey(x, y))) {
        features.push({ type: 'Feature', properties: {}, geometry: tilePolygon(x, y, 17) });
        if (features.length >= DETAIL_MAX_FEATURES) break;
      }
    }
  }
  setData(map, SRC.detail, { type: 'FeatureCollection', features });
}

export function detailKeys(x: number[], y: number[]): Set<number> {
  const s = new Set<number>();
  for (let i = 0; i < x.length; i++) s.add(tileKey(x[i]!, y[i]!));
  return s;
}

/** Toggle which family of layers is visible (zoom 14 tiles vs zoom 17 detail tiles). */
export function setExplorerMode(map: MapLibreMap, zoom: 14 | 17): void {
  const vis = (id: string, on: boolean) =>
    map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  vis(ID.fill, zoom === 14);
  vis(ID.line, zoom === 14);
  vis(ID.cluster, zoom === 14);
  vis(ID.next, zoom === 14);
  vis(ID.detailFill, zoom === 17);
  vis(ID.detailLine, zoom === 17);
}

/** The four enlargements of a square by one tile and the one that needs the fewest unvisited tiles. */
export function nextSquare(
  visited: Set<number>,
  sq: { x: number; y: number; size: number },
): { size: number; x: number; y: number; missing: { x: number; y: number }[] } {
  const size = sq.size + 1;
  let best: { x: number; y: number; missing: { x: number; y: number }[] } | null = null;
  for (const [dx, dy] of [
    [-1, -1],
    [0, -1],
    [-1, 0],
    [0, 0],
  ] as const) {
    const x0 = sq.x + dx;
    const y0 = sq.y + dy;
    const missing: { x: number; y: number }[] = [];
    for (let y = y0; y < y0 + size; y++)
      for (let x = x0; x < x0 + size; x++) if (!visited.has(tileKey(x, y))) missing.push({ x, y });
    if (!best || missing.length < best.missing.length) best = { x: x0, y: y0, missing };
  }
  return { size, ...best! };
}
