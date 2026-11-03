import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MapsWorkoutLinks } from '@cadence/shared';
import { all, get } from '../../db/db';
import { notFound } from '../../lib/http';
import { routeSummaries } from './route-api';
import { effortRows, rankEfforts } from './segments';
import { segmentSummaries } from './segment-api';

const idParam = z.object({ id: z.coerce.number().int().positive() });

/** What the maps feature knows about one workout – for the activity page (route + segment efforts). */
export function registerLinksRoutes(app: FastifyInstance): void {
  app.get('/workouts/:id', async (req): Promise<MapsWorkoutLinks> => {
    const { id } = idParam.parse(req.params);
    const aid = req.athleteId;
    const w = get<{ id: number }>(app.db, 'SELECT id FROM workouts WHERE id = ? AND athlete_id = ?', [
      id,
      aid,
    ]);
    if (!w) throw notFound('Workout');

    // route
    let route: MapsWorkoutLinks['route'] = null;
    const g = get<{ route_id: number | null }>(
      app.db,
      'SELECT route_id FROM maps_workout_geo WHERE workout_id = ?',
      [id],
    );
    if (g?.route_id) {
      const [r] = routeSummaries(app.db, aid, { min: 1, ids: [g.route_id] });
      if (r) {
        const members = all<{ id: number; t: number; start_ts: number }>(
          app.db,
          `SELECT w.id, COALESCE(NULLIF(w.moving_s, 0), w.duration_s) AS t, w.start_ts
           FROM maps_workout_geo g JOIN workouts w ON w.id = g.workout_id
           WHERE g.route_id = ? AND w.hidden = 0 AND w.duplicate_of IS NULL`,
          [g.route_id],
        );
        const me = members.find((m) => m.id === id);
        const rank = me
          ? 1 + members.filter((m) => m.t < me.t || (m.t === me.t && m.start_ts < me.start_ts)).length
          : null;
        route = {
          id: r.id,
          customName: r.customName,
          area: r.area,
          areaEnd: r.areaEnd,
          kind: r.kind,
          distanceM: r.distanceM,
          count: r.count,
          rank,
          bestTimeS: r.bestTimeS,
        };
      }
    }

    // segment efforts of this workout, ranked among all efforts on each segment
    const mine = effortRows(app.db, aid, undefined, id);
    const segIds = [...new Set(mine.map((e) => e.segment_id))];
    const summaries = new Map(segmentSummaries(app.db, aid, segIds).map((s) => [s.id, s]));
    const allEfforts = effortRows(app.db, aid, segIds);
    const ranked = new Map<number, ReturnType<typeof rankEfforts>>();
    for (const sid of segIds) ranked.set(sid, rankEfforts(allEfforts.filter((e) => e.segment_id === sid)));
    const segments: MapsWorkoutLinks['segments'] = [];
    for (const e of mine) {
      const s = summaries.get(e.segment_id);
      const r = ranked.get(e.segment_id)?.find((x) => x.workoutId === id && x.idx === e.idx);
      if (!s || !r) continue;
      segments.push({
        segmentId: s.id,
        name: s.name,
        starred: s.starred,
        idx: e.idx,
        elapsedS: e.elapsed_s,
        avgSpeed: e.avg_speed,
        avgHr: e.avg_hr,
        distanceM: s.distanceM,
        rank: r.rank,
        efforts: s.efforts,
        pr: r.rank === 1,
      });
    }
    segments.sort((a, b) => Number(b.starred) - Number(a.starred) || a.name.localeCompare(b.name));
    return { route, segments };
  });
}
