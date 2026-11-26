import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MapsWorkoutLinks } from '@cadence/shared';
import { get } from '../../db/db';
import { notFound } from '../../lib/http';
import { routeRanks, routesWithEfforts } from './route-api';
import { effortRows, rankEfforts, segmentRows, type EffortRow } from './segments';

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
      // the summary and the rank come from the same visible efforts of the route
      const [r] = routesWithEfforts(app.db, aid, { min: 1, ids: [g.route_id] });
      if (r) {
        const s = r.summary;
        route = {
          id: s.id,
          customName: s.customName,
          area: s.area,
          areaEnd: s.areaEnd,
          kind: s.kind,
          distanceM: s.distanceM,
          count: s.count,
          rank: routeRanks(r.efforts).get(id) ?? null,
          bestTimeS: s.bestTimeS,
        };
      }
    }

    // segment efforts of this workout, ranked among all efforts on each segment: one query for the efforts of every
    // segment it has an effort on, grouped by segment
    const bySegment = new Map<number, EffortRow[]>();
    for (const e of effortRows(app.db, aid, undefined, id)) {
      const l = bySegment.get(e.segment_id);
      if (l) l.push(e);
      else bySegment.set(e.segment_id, [e]);
    }
    // a hidden or duplicate workout has no visible efforts of its own
    const segIds = [...bySegment].filter(([, l]) => l.some((e) => e.workout_id === id)).map(([sid]) => sid);
    const segments: MapsWorkoutLinks['segments'] = [];
    for (const s of segIds.length ? segmentRows(app.db, aid, segIds) : []) {
      const list = bySegment.get(s.id)!;
      for (const r of rankEfforts(list)) {
        if (r.workoutId !== id) continue;
        segments.push({
          segmentId: s.id,
          name: s.name,
          starred: !!s.starred,
          idx: r.idx,
          elapsedS: r.elapsedS,
          avgSpeed: r.avgSpeed,
          avgHr: r.avgHr,
          distanceM: s.distance_m,
          rank: r.rank,
          efforts: list.length,
          pr: r.rank === 1,
        });
      }
    }
    segments.sort((a, b) => Number(b.starred) - Number(a.starred) || a.name.localeCompare(b.name));
    return { route, segments };
  });
}
