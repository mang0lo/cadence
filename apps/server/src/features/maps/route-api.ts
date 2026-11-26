import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  MapsRouteDetail,
  MapsRouteEffort,
  MapsRouteKind,
  MapsRouteSummary,
  MapsRoutesResponse,
} from '@cadence/shared';
import { all, get, run, type Db } from '../../db/db';
import { notFound } from '../../lib/http';
import { IN_LIST, ROUTE_TIME, idList, parseList, visible } from './sql';

const listQuery = z.object({
  sport: z.string().max(200).optional(),
  /** Only routes done at least this many times (default 2: a route done once is no "route" yet). */
  min: z.coerce.number().int().min(1).max(1000).default(2),
});
const idParam = z.object({ id: z.coerce.number().int().positive() });
const patchBody = z.object({ name: z.string().trim().max(120).nullable() });

interface RouteRow {
  id: number;
  sport: string;
  kind: MapsRouteKind;
  area: string | null;
  area_end: string | null;
  custom_name: string | null;
  distance_m: number;
  polyline: string | null;
  start_lat: number | null;
  start_lon: number | null;
  end_lat: number | null;
  end_lon: number | null;
}

interface EffortRow {
  route_id: number;
  workout_id: number;
  name: string;
  sport: string;
  start_ts: number;
  end_ts: number;
  tz_min: number;
  time_s: number;
  distance_m: number | null;
  avg_hr: number | null;
  polyline: string | null;
}

function effortRows(db: Db, athleteId: number, routeIds: number[] | null): EffortRow[] {
  return all<EffortRow>(
    db,
    `SELECT g.route_id, w.id AS workout_id, w.name, w.sport, w.start_ts, w.end_ts, w.tz_min, ${ROUTE_TIME} AS time_s,
            w.distance_m, w.avg_hr, w.polyline
     FROM maps_workout_geo g JOIN workouts w ON w.id = g.workout_id
     WHERE g.athlete_id = ? AND g.route_id IS NOT NULL AND ${visible()}${routeIds ? ` AND g.route_id IN ${IN_LIST}` : ''}
     ORDER BY g.route_id, w.start_ts, w.id`,
    routeIds ? [athleteId, idList(routeIds)] : [athleteId],
  );
}

const speedOf = (e: { distance_m: number | null; time_s: number }, fallbackM: number): number =>
  (e.distance_m ?? fallbackM) / Math.max(1, e.time_s);

/** Summaries for routes with at least `min` visible efforts, built from one pass over their efforts. */
export function routeSummaries(
  db: Db,
  athleteId: number,
  opts: { sport?: string[]; min: number; ids?: number[] },
): MapsRouteSummary[] {
  const where = ['athlete_id = ?'];
  const params: unknown[] = [athleteId];
  if (opts.sport?.length) {
    where.push(`sport IN ${IN_LIST}`);
    params.push(idList(opts.sport));
  }
  if (opts.ids) {
    where.push(`id IN ${IN_LIST}`);
    params.push(idList(opts.ids));
  }
  const routes = all<RouteRow>(
    db,
    `SELECT id, sport, kind, area, area_end, custom_name, distance_m, polyline, start_lat, start_lon, end_lat, end_lon
     FROM maps_routes WHERE ${where.join(' AND ')}`,
    params,
  );
  if (!routes.length) return [];
  const efforts = effortRows(db, athleteId, opts.ids ?? null);
  const byRoute = new Map<number, EffortRow[]>();
  for (const e of efforts) {
    const l = byRoute.get(e.route_id);
    if (l) l.push(e);
    else byRoute.set(e.route_id, [e]);
  }
  const out: MapsRouteSummary[] = [];
  for (const r of routes) {
    const list = byRoute.get(r.id);
    if (!list || list.length < opts.min) continue;
    let best = list[0]!;
    for (const e of list) if (e.time_s < best.time_s) best = e;
    const first = list[0]!;
    const latest = list[list.length - 1]!;
    out.push({
      id: r.id,
      sport: r.sport,
      kind: r.kind,
      area: r.area,
      areaEnd: r.area_end,
      customName: r.custom_name,
      distanceM: r.distance_m,
      count: list.length,
      firstTs: first.start_ts,
      lastTs: latest.start_ts,
      lastTzMin: latest.tz_min,
      bestTimeS: best.time_s,
      bestWorkoutId: best.workout_id,
      latestTimeS: latest.time_s,
      latestWorkoutId: latest.workout_id,
      firstTimeS: first.time_s,
      polyline: r.polyline,
      startLat: r.start_lat,
      startLon: r.start_lon,
      endLat: r.end_lat,
      endLon: r.end_lon,
      trend: list.slice(-12).map((e) => Math.round(speedOf(e, r.distance_m) * 1000) / 1000),
    });
  }
  return out;
}

export function registerRouteRoutes(app: FastifyInstance): void {
  app.get('/routes', async (req): Promise<MapsRoutesResponse> => {
    const q = listQuery.parse(req.query);
    const sports = parseList(q.sport);
    const all_ = routeSummaries(app.db, req.athleteId, { min: q.min });
    const counts = new Map<string, number>();
    for (const r of all_) counts.set(r.sport, (counts.get(r.sport) ?? 0) + 1);
    const items = (sports.length ? all_.filter((r) => sports.includes(r.sport)) : all_).sort(
      (a, b) => b.count - a.count || b.lastTs - a.lastTs,
    );
    return {
      items,
      sports: [...counts.entries()]
        .map(([sport, count]) => ({ sport, count }))
        .sort((a, b) => b.count - a.count),
    };
  });

  app.get('/routes/:id', async (req): Promise<MapsRouteDetail> => {
    const { id } = idParam.parse(req.params);
    const [route] = routeSummaries(app.db, req.athleteId, { min: 1, ids: [id] });
    if (!route) throw notFound('Route');
    const rows = effortRows(app.db, req.athleteId, [id]);
    // rank by time (ties: the earlier effort first)
    const ranked = [...rows].sort((a, b) => a.time_s - b.time_s || a.start_ts - b.start_ts);
    const rank = new Map(ranked.map((e, i) => [e.workout_id, i + 1]));
    const efforts: MapsRouteEffort[] = rows
      .map((e) => ({
        workoutId: e.workout_id,
        name: e.name,
        sport: e.sport,
        startTs: e.start_ts,
        tzMin: e.tz_min,
        timeS: e.time_s,
        elapsedS: e.end_ts - e.start_ts,
        distanceM: e.distance_m,
        avgSpeed: e.distance_m ? e.distance_m / Math.max(1, e.time_s) : null,
        avgHr: e.avg_hr,
        rank: rank.get(e.workout_id)!,
      }))
      .reverse();
    const recent = new Set(rows.slice(-40).map((e) => e.workout_id));
    recent.add(route.bestWorkoutId);
    recent.add(route.latestWorkoutId);
    const tracks = rows
      .filter((e) => recent.has(e.workout_id) && e.polyline)
      .map((e) => ({ workoutId: e.workout_id, polyline: e.polyline! }));
    return { route, efforts, tracks };
  });

  app.patch('/routes/:id', async (req): Promise<MapsRouteSummary> => {
    const { id } = idParam.parse(req.params);
    const body = patchBody.parse(req.body ?? {});
    const r = get<{ id: number }>(app.db, 'SELECT id FROM maps_routes WHERE id = ? AND athlete_id = ?', [
      id,
      req.athleteId,
    ]);
    if (!r) throw notFound('Route');
    run(app.db, 'UPDATE maps_routes SET custom_name = ? WHERE id = ?', [body.name ? body.name : null, id]);
    return routeSummaries(app.db, req.athleteId, { min: 1, ids: [id] })[0]!;
  });
}
