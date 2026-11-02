/**
 * API contract for the "maps" feature. Owned by the maps feature module
 * (apps/server/src/features/maps, apps/web/src/features/maps).
 *
 * Everything is mounted under /api/maps. Quantities are canonical (m, s, m/s), timestamps unix seconds,
 * coordinates WGS84 degrees, polylines Google-encoded with precision 5.
 */

// ---------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------

/** One GPS activity on the heatmap (chronological order, hidden/duplicate workouts excluded). */
export interface MapsHeatmapActivity {
  id: number;
  sport: string;
  /** workouts.name – '' means "use the localized default title" (workoutTitle). */
  name: string;
  startTs: number;
  tzMin: number;
  distanceM: number | null;
  durationS: number;
  /** Simplified route (precision 5). Parts inside privacy zones are already removed. */
  polyline: string;
}

export interface MapsHeatmapFacets {
  /** Sports that have at least one route (unfiltered counts). */
  sports: { sport: string; count: number; distanceM: number }[];
  /** Calendar years (local) that have at least one route. */
  years: { year: number; count: number }[];
}

/** GET /api/maps/heatmap?sport=run,ride&fromDay=YYYY-MM-DD&toDay=YYYY-MM-DD */
export interface MapsHeatmapResponse {
  items: MapsHeatmapActivity[];
  facets: MapsHeatmapFacets;
  /** [minLon, minLat, maxLon, maxLat] of the returned routes. */
  bounds: [number, number, number, number] | null;
  totalDistanceM: number;
  /** True when start/end parts near the athlete's privacy zones were removed. */
  privacyApplied: boolean;
}

// ---------------------------------------------------------------------------
// Slippy-map tile math (shared by the derive step, the API and the Explorer page)
// ---------------------------------------------------------------------------

/** A tile is identified by one number `y * TILE_STRIDE + x` (exact in a double for every zoom ≤ 20). */
export const TILE_STRIDE = 1 << 20;
export const tileKey = (x: number, y: number): number => y * TILE_STRIDE + x;
export const keyX = (k: number): number => k % TILE_STRIDE;
export const keyY = (k: number): number => Math.floor(k / TILE_STRIDE);

const MAX_MERCATOR_LAT = 85.0511287798;

/** Fractional slippy tile coordinates of a WGS84 position at zoom `z` (integer part = tile). */
export function lonLatToTile(lat: number, lon: number, z: number): [x: number, y: number] {
  const n = 2 ** z;
  const la = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const rad = (la * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return [x, y];
}

/** Longitude / latitude of the north-west corner of (fractional) tile coordinates. */
export function tileToLonLat(x: number, y: number, z: number): [lon: number, lat: number] {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lon, lat];
}

/** [minLon, minLat, maxLon, maxLat] of the tiles x..x+w-1 × y..y+h-1. */
export function tileBounds(x: number, y: number, z: number, w = 1, h = 1): [number, number, number, number] {
  const [minLon, maxLat] = tileToLonLat(x, y, z);
  const [maxLon, minLat] = tileToLonLat(x + w, y + h, z);
  return [minLon, minLat, maxLon, maxLat];
}

// ---------------------------------------------------------------------------
// Explorer (visited map tiles)
// ---------------------------------------------------------------------------

/** One visited tile (zoom 14). */
export interface MapsExplorerTile {
  /** Slippy-map tile coordinates. */
  x: number;
  y: number;
  /** Start of the first workout that passed through the tile, and its local UTC offset. */
  firstTs: number;
  tzMin: number;
  /** Number of workouts that passed through. */
  visits: number;
  /** The first workout that passed through. */
  workoutId: number;
  /** All four neighbours (N, E, S, W) are visited too. */
  interior: boolean;
  /** Belongs to the max cluster. */
  cluster: boolean;
}

export interface MapsExplorerMonth {
  /** 'YYYY-MM' (local month of the first visit) */
  month: string;
  newTiles: number;
  /** Visited tiles up to and including this month. */
  total: number;
}

/** GET /api/maps/explorer?zoom=14|17&sport=run,ride */
export interface MapsExplorerResponse {
  zoom: 14 | 17;
  totals: {
    tiles: number;
    /** Edge length of the max square (size × size tiles). */
    maxSquare: number;
    /** Tiles in the max cluster (largest connected group of interior tiles). */
    maxCluster: number;
    /** All interior tiles (visited tiles whose four neighbours are visited). */
    interior: number;
    workouts: number;
  };
  maxSquare: { size: number; x: number; y: number } | null;
  months: MapsExplorerMonth[];
  /** Detail per tile – zoom 14 only. */
  tiles: MapsExplorerTile[];
  /** Zoom 17 only: coordinates of the visited tiles (columnar; the page draws the ones in view). */
  compact: { x: number[]; y: number[] } | null;
  /** [minLon, minLat, maxLon, maxLat] of the visited tiles. */
  bounds: [number, number, number, number] | null;
  /** Sports with at least one route (for the filter). */
  sports: { sport: string; count: number }[];
}

/** GET /api/maps/explorer/summary – numbers for the dashboard widget (zoom 14, all sports). */
export interface MapsExplorerSummary {
  tiles: number;
  maxSquare: number;
  maxCluster: number;
  newThisMonth: number;
  newLastMonth: number;
  workouts: number;
}

// ---------------------------------------------------------------------------
// Routes (same course, done repeatedly)
// ---------------------------------------------------------------------------

export type MapsRouteKind = 'loop' | 'out_and_back' | 'point_to_point';

export interface MapsRouteSummary {
  id: number;
  sport: string;
  kind: MapsRouteKind;
  /** City of the start (from the activity's time zone); null when unknown. */
  area: string | null;
  /** The user's own name; null = show the generated name (area + kind + distance). */
  customName: string | null;
  /** Median length of the efforts. */
  distanceM: number;
  /** Visible (not hidden, not duplicate) workouts on this route. */
  count: number;
  firstTs: number;
  lastTs: number;
  lastTzMin: number;
  /** Times are moving times (the recorded duration when moving time is unknown). */
  bestTimeS: number;
  bestWorkoutId: number;
  latestTimeS: number;
  latestWorkoutId: number;
  firstTimeS: number;
  polyline: string | null;
  startLat: number | null;
  startLon: number | null;
  endLat: number | null;
  endLon: number | null;
  /** Average speed (m/s) of up to the last 12 efforts, oldest first (higher = faster). */
  trend: number[];
}

/** GET /api/maps/routes?sport=run&min=2 */
export interface MapsRoutesResponse {
  items: MapsRouteSummary[];
  /** Routes per sport (independent of the sport filter) for the filter chips. */
  sports: { sport: string; count: number }[];
}

export interface MapsRouteEffort {
  workoutId: number;
  name: string;
  sport: string;
  startTs: number;
  tzMin: number;
  timeS: number;
  elapsedS: number;
  distanceM: number | null;
  avgSpeed: number | null;
  avgHr: number | null;
  /** 1 = fastest effort on the route. */
  rank: number;
}

/** GET /api/maps/routes/:id */
export interface MapsRouteDetail {
  route: MapsRouteSummary;
  /** Newest first. */
  efforts: MapsRouteEffort[];
  /** Simplified tracks of the most recent efforts plus the best and the latest one. */
  tracks: { workoutId: number; polyline: string }[];
}
