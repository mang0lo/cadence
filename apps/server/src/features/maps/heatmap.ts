import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MapsHeatmapActivity, MapsHeatmapResponse, PrivacyZone } from '@cadence/shared';
import { getSettings } from '../../core/settings';
import { all } from '../../db/db';
import { decodePolylineParts, encodePolylineParts, haversine, type LatLon } from '../../lib/geo';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const query = z.object({
  /** Comma separated sport keys; empty = all sports. */
  sport: z.string().max(500).optional(),
  fromDay: day.optional(),
  toDay: day.optional(),
});

/** Hard cap so a pathological dataset cannot produce a multi-hundred-MB response. */
const MAX_ACTIVITIES = 20_000;

const inAnyZone = (p: LatLon, zones: PrivacyZone[], padM = 0): boolean =>
  zones.some((z) => haversine(p[0], p[1], z.lat, z.lon) <= z.radiusM + padM);

/** Drop the leading part of a route that lies inside a zone; the cut is placed exactly on the zone boundary. */
function trimLeading(points: LatLon[], zones: PrivacyZone[]): LatLon[] {
  let i = 0;
  while (i < points.length && inAnyZone(points[i]!, zones)) i++;
  if (i === points.length) return [];
  if (i === 0) return points;
  // points[i - 1] is inside, points[i] outside: bisect the segment for the point where the route leaves the zone
  const a = points[i - 1]!;
  const b = points[i]!;
  let lo = 0; // inside
  let hi = 1; // outside
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2;
    // 2 m of margin: the polyline is rounded to ~1 m, the cut point must stay outside the zone afterwards
    if (inAnyZone([a[0] + (b[0] - a[0]) * mid, a[1] + (b[1] - a[1]) * mid], zones, 2)) lo = mid;
    else hi = mid;
  }
  return [[a[0] + (b[0] - a[0]) * hi, a[1] + (b[1] - a[1]) * hi], ...points.slice(i)];
}

/**
 * Remove the start and the end of a route while they are inside a privacy zone (home, work …), cutting exactly at the
 * zone boundary even when the simplified polyline has no vertex there. The middle of a route is never touched.
 * Returns [] when nothing outside the zones remains.
 */
export function trimPrivacyZones(points: LatLon[], zones: PrivacyZone[]): LatLon[] {
  if (!zones.length || points.length === 0) return points;
  const head = trimLeading(points, zones);
  if (head.length < 2) return [];
  const out = trimLeading([...head].reverse(), zones).reverse();
  if (out.length < 2) return [];
  return out.length === points.length &&
    out[0] === points[0] &&
    out[out.length - 1] === points[points.length - 1]
    ? points
    : out;
}

/** WHERE clause (athlete scoped) shared by the queries: visible workouts that have a route. */
const BASE = `athlete_id = ? AND hidden = 0 AND duplicate_of IS NULL AND has_route = 1 AND polyline IS NOT NULL`;

export function registerHeatmapRoutes(app: FastifyInstance): void {
  app.get('/heatmap', async (req): Promise<MapsHeatmapResponse> => {
    const q = query.parse(req.query);
    const where = [BASE];
    const params: unknown[] = [req.athleteId];
    const sports = (q.sport ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (sports.length) {
      where.push(`sport IN (${sports.map(() => '?').join(',')})`);
      params.push(...sports);
    }
    const localDay = `date(start_ts + tz_min * 60, 'unixepoch')`;
    if (q.fromDay) {
      where.push(`${localDay} >= ?`);
      params.push(q.fromDay);
    }
    if (q.toDay) {
      where.push(`${localDay} <= ?`);
      params.push(q.toDay);
    }
    const rows = all<{
      id: number;
      sport: string;
      name: string;
      start_ts: number;
      tz_min: number;
      distance_m: number | null;
      duration_s: number;
      polyline: string;
    }>(
      app.db,
      `SELECT id, sport, name, start_ts, tz_min, distance_m, duration_s, polyline FROM workouts
       WHERE ${where.join(' AND ')} ORDER BY start_ts, id LIMIT ${MAX_ACTIVITIES}`,
      params,
    );

    const zones = getSettings(app.db, req.athleteId).privacyZones ?? [];
    let privacyApplied = false;
    const items: MapsHeatmapActivity[] = [];
    let minLat = Infinity;
    let minLon = Infinity;
    let maxLat = -Infinity;
    let maxLon = -Infinity;
    let totalDistanceM = 0;
    for (const r of rows) {
      let polyline = r.polyline;
      // a track in several parts (travelled while paused): each part starts and ends somewhere, trim each one
      const decoded = decodePolylineParts(polyline);
      let parts = decoded;
      if (zones.length) {
        let cut = false;
        parts = decoded
          .map((p) => {
            const t = trimPrivacyZones(p, zones);
            // trimPrivacyZones returns the very same array when nothing had to be cut
            if (t !== p) cut = true;
            return t;
          })
          .filter((p) => p.length >= 2);
        if (cut) privacyApplied = true;
        if (!parts.length) continue;
        if (cut) polyline = encodePolylineParts(parts);
      }
      for (const [la, lo] of parts.flat()) {
        if (la < minLat) minLat = la;
        if (la > maxLat) maxLat = la;
        if (lo < minLon) minLon = lo;
        if (lo > maxLon) maxLon = lo;
      }
      totalDistanceM += r.distance_m ?? 0;
      items.push({
        id: r.id,
        sport: r.sport,
        name: r.name,
        startTs: r.start_ts,
        tzMin: r.tz_min,
        distanceM: r.distance_m,
        durationS: r.duration_s,
        polyline,
      });
    }

    const sportsFacet = all<{ sport: string; count: number; distanceM: number }>(
      app.db,
      `SELECT sport, COUNT(*) AS count, COALESCE(SUM(distance_m), 0) AS distanceM FROM workouts
       WHERE ${BASE} GROUP BY sport ORDER BY count DESC, sport`,
      [req.athleteId],
    );
    const yearsFacet = all<{ year: number; count: number }>(
      app.db,
      `SELECT CAST(strftime('%Y', start_ts + tz_min * 60, 'unixepoch') AS INTEGER) AS year, COUNT(*) AS count
       FROM workouts WHERE ${BASE} GROUP BY year ORDER BY year`,
      [req.athleteId],
    );

    return {
      items,
      facets: { sports: sportsFacet, years: yearsFacet },
      bounds: items.length ? [minLon, minLat, maxLon, maxLat] : null,
      totalDistanceM,
      privacyApplied,
    };
  });
}
