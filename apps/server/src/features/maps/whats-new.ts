import type { ImportHighlight } from '@cadence/shared';
import { all, get } from '../../db/db';
import type { WhatsNewInput } from '../types';
import { IN_LIST as NEW_IDS, ROUTE_TIME as TIME, idList, visible } from './sql';

const VISIBLE = visible();

/** Explorer tiles at `z` that only the new activities visited. */
function newTiles(db: WhatsNewInput['db'], athleteId: number, ids: string, z: number): number {
  return get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM (
       SELECT DISTINCT t.x, t.y FROM maps_workout_tiles t
       WHERE t.athlete_id = ? AND t.z = ? AND t.workout_id IN ${NEW_IDS}
         AND NOT EXISTS (
           SELECT 1 FROM maps_workout_tiles o JOIN workouts w ON w.id = o.workout_id
           WHERE o.athlete_id = t.athlete_id AND o.z = t.z AND o.x = t.x AND o.y = t.y AND ${VISIBLE}
             AND o.workout_id NOT IN ${NEW_IDS}))`,
    [athleteId, z, ids, ids],
  )!.n;
}

/**
 * New activities that only replace a copy the athlete already had: the watch's own file of a workout that came from
 * Apple Health before (or the other way round) is preferred over the old copy, which turns into its duplicate. They
 * bring no new tiles, routes or efforts. "Already had" = the copy was stored before the running import job started.
 */
function replacements(db: WhatsNewInput['db'], athleteId: number, ids: string): Set<number> {
  const job = get<{ t: number | null }>(
    db,
    "SELECT MAX(started_at) AS t FROM import_jobs WHERE athlete_id = ? AND status = 'running'",
    [athleteId],
  );
  if (job?.t == null) return new Set();
  return new Set(
    all<{ id: number }>(
      db,
      `SELECT DISTINCT duplicate_of AS id FROM workouts
       WHERE athlete_id = ? AND hidden = 0 AND duplicate_of IN ${NEW_IDS} AND created_at < ?`,
      [athleteId, ids, job.t],
    ).map((r) => r.id),
  );
}

/**
 * New explorer tiles, new recurring routes, route bests and segment PRs of the new activities. A first import only
 * reports nothing here: every tile, route and effort would be new.
 */
export function mapsWhatsNew({ db, athleteId, workoutIds: newIds, initial }: WhatsNewInput): ImportHighlight[] {
  if (initial || !newIds.length) return [];
  const replaced = replacements(db, athleteId, idList(newIds));
  // replacements count as known activities below, like every other visible workout that is not new
  const workoutIds = newIds.filter((id) => !replaced.has(id));
  if (!workoutIds.length) return [];
  const ids = idList(workoutIds);
  const isNew = new Set(workoutIds);
  const out: ImportHighlight[] = [];

  const tiles = newTiles(db, athleteId, ids, 14);
  if (tiles > 0)
    out.push({ feature: 'maps', kind: 'explorerTiles', workoutId: null, data: { count: tiles, squadratinhos: newTiles(db, athleteId, ids, 17) } });

  // routes the new activities belong to, with all their visible efforts
  const efforts = all<{ route_id: number; workout_id: number; time_s: number }>(
    db,
    `SELECT g.route_id, w.id AS workout_id, ${TIME} AS time_s
     FROM maps_workout_geo g JOIN workouts w ON w.id = g.workout_id
     WHERE g.athlete_id = ? AND ${VISIBLE}
       AND g.route_id IN (SELECT route_id FROM maps_workout_geo WHERE route_id IS NOT NULL AND workout_id IN ${NEW_IDS})`,
    [athleteId, ids],
  );
  const byRoute = new Map<number, typeof efforts>();
  for (const e of efforts) byRoute.set(e.route_id, [...(byRoute.get(e.route_id) ?? []), e]);
  const routeInfo = (id: number) =>
    get<{ sport: string; kind: string; area: string | null; area_end: string | null; custom_name: string | null; distance_m: number }>(
      db,
      'SELECT sport, kind, area, area_end, custom_name, distance_m FROM maps_routes WHERE id = ? AND athlete_id = ?',
      [id, athleteId],
    );
  for (const [routeId, list] of byRoute) {
    if (list.length < 2) continue;
    const info = routeInfo(routeId);
    if (!info) continue;
    const base = {
      routeId,
      sport: info.sport,
      routeKind: info.kind,
      area: info.area,
      areaEnd: info.area_end,
      customName: info.custom_name,
      distanceM: info.distance_m,
      efforts: list.length,
    };
    const old = list.filter((e) => !isNew.has(e.workout_id));
    const best = list.reduce((a, b) => (b.time_s < a.time_s ? b : a));
    // a route is recurring (listed on the Routes page) from its second activity on: new if it got there with this import
    if (old.length < 2) out.push({ feature: 'maps', kind: 'newRoute', workoutId: best.workout_id, data: base });
    if (old.length && isNew.has(best.workout_id))
      out.push({
        feature: 'maps',
        kind: 'routeBest',
        workoutId: best.workout_id,
        data: { ...base, timeS: best.time_s, previousS: Math.min(...old.map((e) => e.time_s)) },
      });
  }

  // segments with an effort of a new activity: a new PR when the best effort is new and there was one before
  const segEfforts = all<{ segment_id: number; name: string; workout_id: number; elapsed_s: number }>(
    db,
    `SELECT e.segment_id, s.name, e.workout_id, e.elapsed_s
     FROM maps_segment_efforts e JOIN workouts w ON w.id = e.workout_id JOIN maps_segments s ON s.id = e.segment_id
     WHERE e.athlete_id = ? AND ${VISIBLE}
       AND e.segment_id IN (SELECT segment_id FROM maps_segment_efforts WHERE workout_id IN ${NEW_IDS})`,
    [athleteId, ids],
  );
  const bySegment = new Map<number, typeof segEfforts>();
  for (const e of segEfforts) bySegment.set(e.segment_id, [...(bySegment.get(e.segment_id) ?? []), e]);
  let segmentEfforts = 0;
  for (const [segmentId, list] of bySegment) {
    const fresh = list.filter((e) => isNew.has(e.workout_id));
    segmentEfforts += fresh.length;
    const old = list.filter((e) => !isNew.has(e.workout_id));
    const best = list.reduce((a, b) => (b.elapsed_s < a.elapsed_s ? b : a));
    if (old.length && isNew.has(best.workout_id))
      out.push({
        feature: 'maps',
        kind: 'segmentPr',
        workoutId: best.workout_id,
        data: {
          segmentId,
          name: best.name,
          elapsedS: best.elapsed_s,
          previousS: Math.min(...old.map((e) => e.elapsed_s)),
          efforts: list.length,
        },
      });
  }
  if (segmentEfforts > 0)
    out.push({ feature: 'maps', kind: 'segmentEfforts', workoutId: null, data: { count: segmentEfforts, segments: bySegment.size } });
  return out;
}
