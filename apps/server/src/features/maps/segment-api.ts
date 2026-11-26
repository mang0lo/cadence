import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  valueAtDistance,
  type MapsSegmentDetail,
  type MapsSegmentSource,
  type MapsSegmentSummary,
  type MapsSegmentsResponse,
} from '@cadence/shared';
import { getStreams } from '../../core/workouts';
import { all, get, run, type Db } from '../../db/db';
import { badRequest, notFound } from '../../lib/http';
import {
  createSegment,
  effortRows,
  loadPath,
  rankEfforts,
  segmentRows,
  type EffortRow,
  type SegmentRow,
} from './segments';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const workoutParam = z.object({ workoutId: z.coerce.number().int().positive() });
const name = z.string().trim().min(1).max(120);
const createBody = z.object({
  workoutId: z.number().int().positive(),
  startM: z.number().min(0),
  endM: z.number().positive(),
  name,
});
const patchBody = z.object({ name: name.optional(), starred: z.boolean().optional() });

/** Summaries (with effort statistics of the visible efforts) of some or all segments. */
export function segmentSummaries(db: Db, athleteId: number, ids?: number[]): MapsSegmentSummary[] {
  const rows = segmentRows(db, athleteId, ids);
  if (!rows.length) return [];
  const efforts = effortRows(
    db,
    athleteId,
    rows.map((r) => r.id),
  );
  const bySegment = new Map<number, EffortRow[]>();
  for (const e of efforts) {
    const l = bySegment.get(e.segment_id);
    if (l) l.push(e);
    else bySegment.set(e.segment_id, [e]);
  }
  return rows.map((r) => toSummary(r, bySegment.get(r.id) ?? []));
}

function toSummary(r: SegmentRow, efforts: EffortRow[]): MapsSegmentSummary {
  let pr: EffortRow | null = null;
  for (const e of efforts) if (!pr || e.elapsed_s < pr.elapsed_s) pr = e;
  const last = efforts.length ? efforts[efforts.length - 1]! : null;
  return {
    id: r.id,
    name: r.name,
    sport: r.sport,
    starred: !!r.starred,
    distanceM: r.distance_m,
    elevationGainM: r.elevation_gain_m,
    elevationLossM: r.elevation_loss_m,
    avgGradePct: r.avg_grade,
    polyline: r.polyline,
    startLat: r.start_lat,
    startLon: r.start_lon,
    endLat: r.end_lat,
    endLon: r.end_lon,
    sourceWorkoutId: r.source_workout_id,
    createdAt: r.created_at,
    efforts: efforts.length,
    prTimeS: pr?.elapsed_s ?? null,
    prWorkoutId: pr?.workout_id ?? null,
    prTs: pr?.start_ts ?? null,
    prTzMin: pr?.tz_min ?? null,
    lastTs: last?.start_ts ?? null,
    lastTzMin: last?.tz_min ?? null,
    lastTimeS: last?.elapsed_s ?? null,
  };
}

function detail(db: Db, athleteId: number, id: number): MapsSegmentDetail {
  const [segment] = segmentSummaries(db, athleteId, [id]);
  if (!segment) throw notFound('Segment');
  const { prof } = loadPath(db, id);
  const efforts = rankEfforts(effortRows(db, athleteId, [id])).reverse();
  return { segment, profile: { dist: prof.dist, ele: prof.ele }, efforts };
}

export function registerSegmentRoutes(app: FastifyInstance): void {
  app.get('/segments', async (req): Promise<MapsSegmentsResponse> => {
    const items = segmentSummaries(app.db, req.athleteId).sort(
      (a, b) =>
        Number(b.starred) - Number(a.starred) ||
        (b.lastTs ?? 0) - (a.lastTs ?? 0) ||
        b.createdAt - a.createdAt ||
        b.id - a.id,
    );
    return { items };
  });

  app.get('/segments/:id', async (req): Promise<MapsSegmentDetail> => {
    const { id } = idParam.parse(req.params);
    return detail(app.db, req.athleteId, id);
  });

  app.post('/segments', async (req, reply): Promise<MapsSegmentDetail> => {
    const body = createBody.parse(req.body ?? {});
    if (body.endM <= body.startM) throw badRequest('The end of the segment has to be after its start');
    const id = await createSegment(app.db, req.athleteId, body);
    reply.code(201);
    return detail(app.db, req.athleteId, id);
  });

  app.patch('/segments/:id', async (req): Promise<MapsSegmentDetail> => {
    const { id } = idParam.parse(req.params);
    const body = patchBody.parse(req.body ?? {});
    if (!get(app.db, 'SELECT 1 FROM maps_segments WHERE id = ? AND athlete_id = ?', [id, req.athleteId]))
      throw notFound('Segment');
    if (body.name !== undefined)
      run(app.db, 'UPDATE maps_segments SET name = ? WHERE id = ?', [body.name, id]);
    if (body.starred !== undefined)
      run(app.db, 'UPDATE maps_segments SET starred = ? WHERE id = ?', [body.starred ? 1 : 0, id]);
    return detail(app.db, req.athleteId, id);
  });

  app.delete('/segments/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const r = run(app.db, 'DELETE FROM maps_segments WHERE id = ? AND athlete_id = ?', [id, req.athleteId]);
    if (!r.changes) throw notFound('Segment');
    reply.code(204);
    return reply.send();
  });

  /** The route of a workout, thinned to ≤ 1200 points, for the segment editor. */
  app.get('/segments/source/:workoutId', async (req): Promise<MapsSegmentSource> => {
    const { workoutId } = workoutParam.parse(req.params);
    const w = get<{ id: number; name: string; sport: string; start_ts: number; tz_min: number }>(
      app.db,
      'SELECT id, name, sport, start_ts, tz_min FROM workouts WHERE id = ? AND athlete_id = ?',
      [workoutId, req.athleteId],
    );
    if (!w) throw notFound('Workout');
    const s = getStreams(app.db, req.athleteId, workoutId);
    if (!s?.lat || !s.lon || !s.dist || s.lat.length < 2) throw badRequest('This activity has no GPS route');
    const total = s.dist[s.dist.length - 1]!;
    const step = Math.max(5, total / 1200);
    const n = Math.max(2, Math.floor(total / step) + 1);
    const points: MapsSegmentSource['points'] = { lat: [], lon: [], dist: [], ele: [], t: [] };
    for (let k = 0; k < n; k++) {
      const d = k === n - 1 ? total : k * step;
      points.dist.push(Math.round(d * 10) / 10);
      points.lat.push(Math.round(valueAtDistance(s.dist, s.lat, d)! * 1e6) / 1e6);
      points.lon.push(Math.round(valueAtDistance(s.dist, s.lon, d)! * 1e6) / 1e6);
      const e = s.ele ? valueAtDistance(s.dist, s.ele, d) : null;
      points.ele.push(e === null ? null : Math.round(e * 10) / 10);
      points.t.push(Math.round((valueAtDistance(s.dist, s.t, d) ?? 0) * 10) / 10);
    }
    const existing = all<{ id: number; name: string }>(
      app.db,
      `SELECT DISTINCT s.id, s.name FROM maps_segment_efforts e JOIN maps_segments s ON s.id = e.segment_id
       WHERE e.workout_id = ? AND s.athlete_id = ? ORDER BY s.name`,
      [workoutId, req.athleteId],
    );
    return {
      workoutId,
      name: w.name,
      sport: w.sport,
      startTs: w.start_ts,
      tzMin: w.tz_min,
      totalM: total,
      points,
      breaksM: (s.breaks ?? []).map((k) => Math.round((s.dist![k] ?? 0) * 10) / 10),
      existing,
    };
  });
}
