import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import { decodePolylineParts } from '@/lib/polyline';
import { homeRegion, type BBox } from './home';
import { firstSymbolLayer } from './layerOrder';
import type { MapsHeatmapActivity } from '@cadence/shared';

export type HeatTheme = 'hot' | 'blue' | 'purple';
export type HeatBase = 'dark' | 'satellite' | 'streets';

/**
 * A decoded route ready for the map. `i` = chronological index among the drawable routes (0, 1, 2 … without gaps):
 * the time-lapse key and the map feature id.
 */
export interface HeatLine {
  id: number;
  i: number;
  sport: string;
  /** [lon, lat] of all parts, concatenated */
  coords: [number, number][];
  /**
   * Vertex index where each part of the track starts ([0] for an ordinary route; more when the workout was paused and
   * continued elsewhere). Parts are drawn as separate lines.
   */
  starts: number[];
  /** Cumulative planar length per vertex (degrees-ish, only used for fractions; nothing across a part boundary). */
  cum: number[];
}

/** The parts of a heat line as separate coordinate lists. */
export function lineParts(l: HeatLine): [number, number][][] {
  return l.starts.map((s, p) => l.coords.slice(s, l.starts[p + 1] ?? l.coords.length)).filter((c) => c.length > 1);
}

export interface HeatPalette {
  glow: string;
  mid: string;
  core: string;
  hot: string;
  /** Overall opacity multiplier – light basemaps need stronger lines. */
  strength: number;
}

const DARK: Record<HeatTheme, HeatPalette> = {
  hot: {
    glow: '#ff4d00',
    mid: '#ff8a1f',
    core: '#ffc247',
    hot: '#fff3c4',
    strength: 1,
  },
  blue: {
    glow: '#1e5bff',
    mid: '#2aa3ff',
    core: '#6fe0ff',
    hot: '#e9fcff',
    strength: 1,
  },
  purple: {
    glow: '#7a1fff',
    mid: '#b04dff',
    core: '#e08cff',
    hot: '#fff0ff',
    strength: 1,
  },
};

/** Darker, saturated variants that stay readable on a light basemap. */
const LIGHT: Record<HeatTheme, HeatPalette> = {
  hot: {
    glow: '#ff7a1a',
    mid: '#e8590c',
    core: '#c2410c',
    hot: '#7c2d12',
    strength: 1.5,
  },
  blue: {
    glow: '#5598e7',
    mid: '#2a78d6',
    core: '#1c5cab',
    hot: '#104281',
    strength: 1.5,
  },
  purple: {
    glow: '#a98bff',
    mid: '#845ef7',
    core: '#6741d9',
    hot: '#4c2a9e',
    strength: 1.5,
  },
};

const hexA = (hex: string, a: number): string => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

export const heatPalette = (theme: HeatTheme, darkBase: boolean): HeatPalette =>
  (darkBase ? DARK : LIGHT)[theme];

/** Decode the API polylines into map lines (lon/lat order) with cumulative lengths. */
export function toHeatLines(items: MapsHeatmapActivity[]): HeatLine[] {
  const out: HeatLine[] = [];
  items.forEach((a) => {
    const parts = decodePolylineParts(a.polyline).filter((p) => p.length > 1);
    if (!parts.length) return;
    const i = out.length; // an item without a drawable route leaves no gap
    const coords: [number, number][] = [];
    const starts: number[] = [];
    for (const p of parts) {
      starts.push(coords.length);
      for (const [la, lo] of p) coords.push([lo, la]);
    }
    const first = new Set(starts);
    const cum: number[] = [0];
    const k = Math.cos((coords[0]![1] * Math.PI) / 180);
    for (let j = 1; j < coords.length; j++) {
      const dx = (coords[j]![0] - coords[j - 1]![0]) * k;
      const dy = coords[j]![1] - coords[j - 1]![1];
      cum.push(cum[j - 1]! + (first.has(j) ? 0 : Math.hypot(dx, dy)));
    }
    out.push({ id: a.id, i, sport: a.sport, coords, starts, cum });
  });
  return out;
}

/** First `fraction` (0..1) of a line, with an interpolated last vertex: one coordinate list per part drawn so far. */
export function partialCoords(line: HeatLine, fraction: number): [number, number][][] {
  const total = line.cum[line.cum.length - 1] ?? 0;
  if (fraction >= 1 || total <= 0) return lineParts(line);
  const target = total * Math.max(0, fraction);
  let j = 1;
  while (j < line.cum.length - 1 && line.cum[j]! < target) j++;
  // parts that were completed before vertex j, then the current part up to the interpolated point
  let p = 0;
  while (p + 1 < line.starts.length && line.starts[p + 1]! <= j - 1) p++;
  const done = lineParts({ ...line, coords: line.coords.slice(0, line.starts[p]), starts: line.starts.slice(0, p) });
  const out = line.coords.slice(line.starts[p], j);
  const seg = line.cum[j]! - line.cum[j - 1]!;
  const f = seg > 0 ? (target - line.cum[j - 1]!) / seg : 0;
  const a = line.coords[j - 1]!;
  const b = line.coords[j]!;
  if (!line.starts.includes(j)) out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  return [...done, out];
}

function lineBox(l: HeatLine): BBox {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lo, la] of l.coords) {
    if (lo < minLon) minLon = lo;
    if (lo > maxLon) maxLon = lo;
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
  }
  return [minLon, minLat, maxLon, maxLat];
}

/** Bounds of the home region of the routes (see homeRegion): a trip abroad does not zoom out to the whole world. */
export const mainBounds = (lines: HeatLine[]): BBox | null => homeRegion(lines, (l) => l.coords[0]!, lineBox);

export function linesCollection(lines: HeatLine[]): FeatureCollection<LineString> {
  return {
    type: 'FeatureCollection',
    features: lines.flatMap((l) =>
      lineParts(l).map(
        (coords): Feature<LineString> => ({
          type: 'Feature',
          properties: { id: l.id, i: l.i, sport: l.sport },
          geometry: { type: 'LineString', coordinates: coords },
        }),
      ),
    ),
  };
}

/**
 * Input of the density layer: points along all routes, roughly every `spacingM` meters (the spacing grows so that
 * there are never more than `maxPoints`), summed per ~`cellM` grid cell into one point at their mean position with the
 * count as weight `w`. The heatmap adds weights like points, so it looks the same, but routes that overlap (the
 * streets around home) give one feature instead of one per pass: ~23× fewer features to send to the map worker.
 */
export function densityPoints(
  lines: HeatLine[],
  spacingM = 40,
  maxPoints = 250_000,
  cellM = 20,
): { points: FeatureCollection<Point>; maxPasses: number } {
  const M_PER_DEG = 111_320;
  let totalM = 0;
  for (const l of lines) totalM += (l.cum[l.cum.length - 1] ?? 0) * M_PER_DEG;
  const step = Math.max(spacingM, totalM / maxPoints) / M_PER_DEG;
  // grid of ~cellM square cells: rows of cellLat degrees, each row with its own longitude width
  const cellLat = cellM / M_PER_DEG;
  const half = Math.ceil(180 / cellLat) + 1;
  const sums = new Map<number, { lon: number; lat: number; n: number }>();
  // number of different routes per ~100 m cell → normalisation of the density layer
  const cells = new Map<number, number>();
  let seen = new Set<number>();
  let lastRow = NaN;
  let cellLon = cellLat;
  const push = (c: [number, number]) => {
    const row = Math.floor(c[1] / cellLat);
    if (row !== lastRow) {
      lastRow = row;
      cellLon = cellLat / Math.max(0.01, Math.cos(((row + 0.5) * cellLat * Math.PI) / 180));
    }
    const key = row * (2 * half + 1) + Math.floor(c[0] / cellLon) + half;
    const sum = sums.get(key);
    if (sum) {
      sum.lon += c[0];
      sum.lat += c[1];
      sum.n++;
    } else sums.set(key, { lon: c[0], lat: c[1], n: 1 });
    seen.add(Math.floor(c[0] / 0.0015) * 100_003 + Math.floor(c[1] / 0.001));
  };
  for (const l of lines) {
    seen = new Set();
    push(l.coords[0]!);
    let carry = 0; // distance travelled since the last emitted point
    for (let j = 1; j < l.coords.length; j++) {
      // vertices are sparse on straight stretches: walk along the segment and emit a point every `step`
      const segLen = l.cum[j]! - l.cum[j - 1]!;
      const a = l.coords[j - 1]!;
      const b = l.coords[j]!;
      let pos = step - carry;
      while (pos <= segLen) {
        const f = segLen > 0 ? pos / segLen : 0;
        push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
        pos += step;
      }
      carry = segLen - (pos - step);
    }
    for (const k of seen) cells.set(k, (cells.get(k) ?? 0) + 1);
  }
  let maxPasses = 1;
  for (const n of cells.values()) if (n > maxPasses) maxPasses = n;
  const features: Feature<Point>[] = [];
  for (const { lon, lat, n } of sums.values())
    features.push({ type: 'Feature', properties: { w: n }, geometry: { type: 'Point', coordinates: [lon / n, lat / n] } });
  return { points: { type: 'FeatureCollection', features }, maxPasses };
}

const emptyLines: FeatureCollection<LineString> = { type: 'FeatureCollection', features: [] };
const emptyPoints: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] };

export const LAYER = {
  density: 'hm-density',
  glow: 'hm-glow',
  mid: 'hm-mid',
  core: 'hm-core',
  hot: 'hm-hot',
  headGlow: 'hm-head-glow',
  head: 'hm-head',
  hit: 'hm-hit',
} as const;
const SRC = { lines: 'hm-lines', head: 'hm-head', points: 'hm-points' } as const;

/**
 * Opacity of a finished-activities layer: 0 while the time-lapse hides the activity (feature state 'hidden', see
 * LapseVisibility). Feature state changes repaint the affected features; a filter change would re-tile the whole
 * source in the worker, on every frame of the time-lapse.
 */
const lapseOpacity = (opacity: number): ExpressionSpecification =>
  ['case', ['boolean', ['feature-state', 'hidden'], false], 0, opacity] as unknown as ExpressionSpecification;

const zoomWidth = (a: number, b: number, c: number): ExpressionSpecification =>
  ['interpolate', ['linear'], ['zoom'], 8, a, 12, b, 16, c] as unknown as ExpressionSpecification;

/**
 * Create the sources and layers (idempotent – call again after every basemap style switch). Cheap once they exist:
 * the time-lapse calls it on every frame.
 */
export function ensureHeatLayers(map: MapLibreMap, palette: HeatPalette): void {
  if (map.getLayer(LAYER.hit)) return; // added last: everything exists
  // the glow goes below the basemap labels so they stay readable
  const before = firstSymbolLayer(map);
  // feature id = chronological index `i`: the time-lapse hides activities through feature state
  if (!map.getSource(SRC.lines)) map.addSource(SRC.lines, { type: 'geojson', data: emptyLines, promoteId: 'i' });
  if (!map.getSource(SRC.head)) map.addSource(SRC.head, { type: 'geojson', data: emptyLines });
  if (!map.getSource(SRC.points)) map.addSource(SRC.points, { type: 'geojson', data: emptyPoints });
  const s = palette.strength;
  const line = (id: string, source: string, paint: Record<string, unknown>): void => {
    if (map.getLayer(id)) return;
    map.addLayer(
      {
        id,
        type: 'line',
        source,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: paint as never,
      },
      before,
    );
  };
  if (!map.getLayer(LAYER.density)) {
    map.addLayer(
      {
        id: LAYER.density,
        type: 'heatmap',
        source: SRC.points,
        layout: { visibility: 'none' },
        paint: {
          // points of the same ~20 m cell are summed into one (densityPoints)
          'heatmap-weight': ['get', 'w'] as unknown as ExpressionSpecification,
          'heatmap-intensity': 0.01,
          'heatmap-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8,
            3,
            12,
            9,
            16,
            22,
          ] as unknown as ExpressionSpecification,
          'heatmap-opacity': 0.9,
          'heatmap-color': densityRamp(palette),
        },
      },
      before,
    );
  }
  // Low-opacity strokes stack: a street used once is dim, a street used 20 times is saturated and bright.
  line(LAYER.glow, SRC.lines, {
    'line-color': palette.glow,
    'line-width': zoomWidth(5, 9, 18),
    'line-blur': zoomWidth(4, 7, 12),
    'line-opacity': lapseOpacity(Math.min(1, 0.07 * s)),
  });
  line(LAYER.mid, SRC.lines, {
    'line-color': palette.mid,
    'line-width': zoomWidth(2.2, 3.4, 6),
    'line-blur': 1.5,
    'line-opacity': lapseOpacity(Math.min(1, 0.14 * s)),
  });
  line(LAYER.core, SRC.lines, {
    'line-color': palette.core,
    'line-width': zoomWidth(0.9, 1.4, 2.6),
    'line-opacity': lapseOpacity(Math.min(1, 0.22 * s)),
  });
  line(LAYER.hot, SRC.lines, {
    'line-color': palette.hot,
    'line-width': zoomWidth(0.5, 0.8, 1.4),
    'line-opacity': lapseOpacity(Math.min(1, 0.3 * s)),
  });
  // the activity currently being drawn by the time-lapse
  line(LAYER.headGlow, SRC.head, {
    'line-color': palette.core,
    'line-width': zoomWidth(6, 10, 18),
    'line-blur': zoomWidth(5, 8, 12),
    'line-opacity': 0.5,
  });
  line(LAYER.head, SRC.head, {
    'line-color': palette.hot,
    'line-width': zoomWidth(1.4, 2.2, 3.6),
    'line-opacity': 1,
  });
  // invisible, wide: makes thin lines easy to click
  line(LAYER.hit, SRC.lines, { 'line-color': '#000000', 'line-width': 14, 'line-opacity': 0 });
}

/** Roughly logarithmic ramp: a street used once is faint, the busiest street reaches the hot color. */
function densityRamp(p: HeatPalette): ExpressionSpecification {
  const stops: [number, string][] = [
    [0, hexA(p.glow, 0)],
    [0.03, hexA(p.glow, 0.3)],
    [0.12, hexA(p.glow, 0.55)],
    [0.3, hexA(p.mid, 0.75)],
    [0.6, hexA(p.core, 0.9)],
    [1, hexA(p.hot, 1)],
  ];
  return [
    'interpolate',
    ['linear'],
    ['heatmap-density'],
    ...stops.flat(),
  ] as unknown as ExpressionSpecification;
}

/**
 * The heatmap layer adds up kernels, so its intensity has to follow the busiest street: 1/maxPasses scaled by how
 * many points per kernel a zoom level holds (derived for points every ~40 m and the radii used below).
 */
export function setDensityIntensity(map: MapLibreMap, maxPasses: number): void {
  if (!map.getLayer(LAYER.density)) return;
  const k = 1 / Math.max(3, maxPasses);
  map.setPaintProperty(LAYER.density, 'heatmap-intensity', [
    'interpolate',
    ['linear'],
    ['zoom'],
    8,
    k / 27,
    12,
    k / 5,
    16,
    k / 0.8,
  ] as unknown as ExpressionSpecification);
}

/** Re-color the layers (theme / basemap change) without recreating them. */
export function applyHeatPalette(map: MapLibreMap, palette: HeatPalette): void {
  if (!map.getLayer(LAYER.glow)) return;
  const s = palette.strength;
  map.setPaintProperty(LAYER.glow, 'line-color', palette.glow);
  map.setPaintProperty(LAYER.glow, 'line-opacity', lapseOpacity(Math.min(1, 0.07 * s)));
  map.setPaintProperty(LAYER.mid, 'line-color', palette.mid);
  map.setPaintProperty(LAYER.mid, 'line-opacity', lapseOpacity(Math.min(1, 0.14 * s)));
  map.setPaintProperty(LAYER.core, 'line-color', palette.core);
  map.setPaintProperty(LAYER.core, 'line-opacity', lapseOpacity(Math.min(1, 0.22 * s)));
  map.setPaintProperty(LAYER.hot, 'line-color', palette.hot);
  map.setPaintProperty(LAYER.hot, 'line-opacity', lapseOpacity(Math.min(1, 0.3 * s)));
  map.setPaintProperty(LAYER.headGlow, 'line-color', palette.core);
  map.setPaintProperty(LAYER.head, 'line-color', palette.hot);
  map.setPaintProperty(LAYER.density, 'heatmap-color', densityRamp(palette));
}

function setData(map: MapLibreMap, id: string, data: FeatureCollection): void {
  (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);
}

export const setLinesData = (map: MapLibreMap, fc: FeatureCollection<LineString>) =>
  setData(map, SRC.lines, fc);
export const setPointsData = (map: MapLibreMap, fc: FeatureCollection<Point>) => setData(map, SRC.points, fc);

export function setHeadLine(map: MapLibreMap, lines: [number, number][][] | null): void {
  setData(map, SRC.head, {
    type: 'FeatureCollection',
    features: (lines ?? [])
      .filter((c) => c.length > 1)
      .map((coordinates) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } })),
  });
}

/**
 * Which activities the time-lapse shows: the first `done` (by `i`), or all. The others carry the feature state
 * `hidden` (see lapseOpacity). Only the activities whose visibility changes are touched, so a frame that finishes one
 * activity is one feature-state update instead of a filter change that re-tiles every line.
 */
export class LapseVisibility {
  /** The lines source the state was set on, and the ids hidden there: [from, to). */
  private hidden: { source: unknown; from: number; to: number } | null = null;

  /**
   * Show the first `done` of the `total` activities (null: all of them). Feature state outlives setData, so new data
   * only changes the ids whose visibility differs (ids are positions); a new source (after a style switch) has none.
   */
  apply(map: MapLibreMap, done: number | null, total: number): void {
    const source = map.getSource(SRC.lines);
    if (!source) return;
    const prev = this.hidden?.source === source ? this.hidden : { from: 0, to: 0 };
    const from = done === null ? 0 : Math.min(done, total);
    const to = done === null ? 0 : total;
    const set = (a: number, b: number, hidden: boolean) => {
      for (let i = a; i < b; i++) map.setFeatureState({ source: SRC.lines, id: i }, { hidden });
    };
    // hide what is new in [from, to), show what left it: explicit states, no removeFeatureState (MapLibre keeps
    // state changes queued before a full removal when another state is set in the same frame)
    set(from, Math.min(to, prev.from), true);
    set(Math.max(from, prev.to), to, true);
    set(prev.from, Math.min(prev.to, from), false);
    set(Math.max(prev.from, to), prev.to, false);
    this.hidden = { source, from, to };
  }
}

/**
 * A time-lapse position in activities (2.5: two finished, the third half drawn) as the number of finished activities
 * and the drawn fraction of the next one.
 */
export function lapseAt(progress: number, count: number): { done: number; frac: number } {
  const done = Math.max(0, Math.min(count, Math.floor(progress)));
  return { done, frac: done < count ? Math.max(0, progress - done) : 0 };
}

/**
 * Draws the time-lapse at a position (see lapseAt; null: off, every activity shown): the finished activities
 * (LapseVisibility) and the head, the part of the next activity drawn so far. A frame changes the head, plus one
 * feature state when an activity finishes; nothing is sent again that the map already shows.
 */
export class LapseDrawer {
  private visibility = new LapseVisibility();
  /** The head source last drawn to, and whether it shows a line there. */
  private head: { source: unknown; line: boolean } | null = null;

  draw(map: MapLibreMap, lines: HeatLine[], progress: number | null): void {
    const at = progress === null ? null : lapseAt(progress, lines.length);
    this.visibility.apply(map, at ? at.done : null, lines.length);
    const line = at && at.frac > 0 ? lines[at.done] : undefined;
    const head = line && at ? partialCoords(line, at.frac) : null;
    const source = map.getSource(SRC.head);
    if (!source) return;
    if (!head && this.head?.source === source && !this.head.line) return;
    setHeadLine(map, head);
    this.head = { source, line: !!head };
  }
}

export function setDensityVisible(map: MapLibreMap, visible: boolean): void {
  if (map.getLayer(LAYER.density))
    map.setLayoutProperty(LAYER.density, 'visibility', visible ? 'visible' : 'none');
}
