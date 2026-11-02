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
