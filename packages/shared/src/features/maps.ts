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

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

const SEGMENT_FAMILIES: string[][] = [
  ['run', 'track_and_field'],
  ['walk', 'hike'],
  ['ride', 'handcycle'],
  ['alpine_ski', 'snowboard'],
];

/** Sports whose workouts can ride a segment that was drawn on a workout of `sport` (same pace class). */
export const segmentSports = (sport: string): string[] =>
  SEGMENT_FAMILIES.find((f) => f.includes(sport)) ?? [sport];

/** A segment is at least this long (m). */
export const MIN_SEGMENT_M = 100;

/** Value of a series at distance `d` (linear interpolation, clamped); `dist` must be ascending. */
export function valueAtDistance(
  dist: ArrayLike<number>,
  values: ArrayLike<number | null>,
  d: number,
): number | null {
  const n = dist.length;
  if (!n) return null;
  if (d <= dist[0]!) return values[0] ?? null;
  if (d >= dist[n - 1]!) return values[n - 1] ?? null;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid]! <= d) lo = mid;
    else hi = mid;
  }
  const a = values[lo];
  const b = values[hi];
  if (a == null) return b ?? null;
  if (b == null) return a;
  const span = dist[hi]! - dist[lo]!;
  return span > 0 ? a + ((b - a) * (d - dist[lo]!)) / span : a;
}

export interface ProfileSlice {
  distanceM: number;
  gainM: number;
  lossM: number;
  startEleM: number | null;
  endEleM: number | null;
  /** (end − start elevation) / distance in percent. */
  gradePct: number | null;
}

/**
 * Distance / elevation gain & loss / average grade of the part [fromM, toM] of a track given its cumulative distance
 * and elevation. The elevation is resampled every few meters, lightly smoothed and summed with a 1 m dead band, so
 * GPS noise does not pile up as "climbing". Used live by the segment editor and again by the server when saving.
 */
export function profileSlice(
  dist: ArrayLike<number>,
  ele: ArrayLike<number | null> | null | undefined,
  fromM: number,
  toM: number,
): ProfileSlice {
  const distanceM = Math.max(0, toM - fromM);
  const out: ProfileSlice = { distanceM, gainM: 0, lossM: 0, startEleM: null, endEleM: null, gradePct: null };
  if (!ele || dist.length < 2 || distanceM <= 0) return out;
  // only samples that carry an elevation take part
  const d: number[] = [];
  const e: number[] = [];
  for (let i = 0; i < dist.length; i++) {
    const v = ele[i];
    if (v != null && Number.isFinite(v)) {
      d.push(dist[i]!);
      e.push(v);
    }
  }
  if (d.length < 2) return out;
  const step = Math.min(10, Math.max(2, distanceM / 60));
  const n = Math.max(2, Math.round(distanceM / step) + 1);
  const raw = new Array<number>(n);
  for (let k = 0; k < n; k++) raw[k] = valueAtDistance(d, e, fromM + (distanceM * k) / (n - 1))!;
  const half = 2;
  const sm = raw.map((_, k) => {
    let sum = 0;
    let cnt = 0;
    for (let q = Math.max(0, k - half); q <= Math.min(n - 1, k + half); q++) {
      sum += raw[q]!;
      cnt++;
    }
    return sum / cnt;
  });
  let ref = sm[0]!;
  for (let k = 1; k < n; k++) {
    const v = sm[k]!;
    if (v - ref >= 1) {
      out.gainM += v - ref;
      ref = v;
    } else if (ref - v >= 1) {
      out.lossM += ref - v;
      ref = v;
    }
  }
  out.startEleM = sm[0]!;
  out.endEleM = sm[n - 1]!;
  out.gradePct = ((out.endEleM - out.startEleM) / distanceM) * 100;
  return out;
}

export interface MapsSegmentSummary {
  id: number;
  name: string;
  /** Sport of the workout the segment was drawn on; efforts of its compatible sports count. */
  sport: string;
  starred: boolean;
  distanceM: number;
  elevationGainM: number | null;
  elevationLossM: number | null;
  /** Average grade in percent. */
  avgGradePct: number | null;
  polyline: string;
  startLat: number;
  startLon: number;
  endLat: number;
  endLon: number;
  sourceWorkoutId: number | null;
  createdAt: number;
  /** Visible efforts (hidden / duplicate workouts excluded). */
  efforts: number;
  /** Personal record = fastest effort. */
  prTimeS: number | null;
  prWorkoutId: number | null;
  prTs: number | null;
  prTzMin: number | null;
  lastTs: number | null;
  lastTzMin: number | null;
  lastTimeS: number | null;
}

export interface MapsSegmentEffort {
  workoutId: number;
  /** Position inside the workout when it passed the segment more than once. */
  idx: number;
  name: string;
  sport: string;
  startTs: number;
  tzMin: number;
  /** Interpolated crossing times: start → end. */
  elapsedS: number;
  movingS: number | null;
  avgSpeed: number;
  avgHr: number | null;
  /** 1 = fastest. */
  rank: number;
  /** Was the fastest effort at the time it was ridden. */
  pr: boolean;
}

/** GET /api/maps/segments/:id */
export interface MapsSegmentDetail {
  segment: MapsSegmentSummary;
  /** Elevation profile along the segment (≤ 300 points); `ele` entries are null when unknown. */
  profile: { dist: number[]; ele: (number | null)[] };
  /** Newest first. */
  efforts: MapsSegmentEffort[];
}

/** GET /api/maps/segments */
export interface MapsSegmentsResponse {
  items: MapsSegmentSummary[];
}

/** POST /api/maps/segments – positions are meters along the workout's route. */
export interface MapsSegmentCreate {
  workoutId: number;
  startM: number;
  endM: number;
  name: string;
}

/** PATCH /api/maps/segments/:id */
export interface MapsSegmentPatch {
  name?: string;
  starred?: boolean;
}

/** GET /api/maps/segments/source/:workoutId – the route of a workout, thinned for the segment editor. */
export interface MapsSegmentSource {
  workoutId: number;
  name: string;
  sport: string;
  startTs: number;
  tzMin: number;
  totalM: number;
  /** Index-aligned arrays (≤ 1200 points, increasing distance). `t` = seconds since the workout start. */
  points: { lat: number[]; lon: number[]; dist: number[]; ele: (number | null)[]; t: number[] };
  /** Segments that already cover (part of) this route, for a hint. */
  existing: { id: number; name: string }[];
}

/** GET /api/maps/workouts/:id – what the maps feature knows about one workout (for the activity page). */
export interface MapsWorkoutLinks {
  route: {
    id: number;
    customName: string | null;
    area: string | null;
    kind: MapsRouteKind;
    distanceM: number;
    /** Visible workouts on this route. */
    count: number;
    /** Rank of this workout's time among them (1 = fastest). */
    rank: number | null;
    bestTimeS: number;
  } | null;
  segments: {
    segmentId: number;
    name: string;
    starred: boolean;
    idx: number;
    elapsedS: number;
    avgSpeed: number;
    avgHr: number | null;
    distanceM: number;
    /** Rank among all efforts on the segment (1 = personal record). */
    rank: number;
    efforts: number;
    pr: boolean;
  }[];
}
