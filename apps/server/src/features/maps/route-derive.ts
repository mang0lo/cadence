import { all, prepare, run, tx, type Db } from '../../db/db';
import type { DeriveStep } from '../types';
import { nearestPlace } from '../../lib/places';
import {
  assignRoutes,
  makeSignature,
  matchOldRoutes,
  routeKind,
  type RouteRep,
  type RouteSignature,
  type ShapedWorkout,
} from './route-shapes';
import { IN_LIST, idList } from './sql';

/**
 * Delete the shapes of the workouts `where` (a condition on maps_workout_geo) selects. Their routes lose members and
 * are marked for the next refresh (no representative): an incremental derive refreshes only the routes its workouts
 * are on, and these workouts are on none any more.
 */
export function deleteShapes(db: Db, where: string, params: unknown[]): void {
  run(
    db,
    `UPDATE maps_routes SET rep_workout_id = NULL
     WHERE id IN (SELECT route_id FROM maps_workout_geo WHERE route_id IS NOT NULL AND ${where})`,
    params,
  );
  run(db, `DELETE FROM maps_workout_geo WHERE ${where}`, params);
}

/** Store (or remove) the shape signature of a workout. Keeps its current route assignment. */
export function storeSignature(
  db: Db,
  athleteId: number,
  workoutId: number,
  lat: ArrayLike<number> | undefined,
  lon: ArrayLike<number> | undefined,
  dist: ArrayLike<number> | undefined,
): boolean {
  const sig = lat && lon ? makeSignature(lat, lon, dist) : null;
  if (!sig) {
    deleteShapes(db, 'workout_id = ?', [workoutId]);
    return false;
  }
  run(
    db,
    `INSERT INTO maps_workout_geo (workout_id, athlete_id, length_m, sig, route_id) VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (workout_id) DO UPDATE SET length_m = excluded.length_m, sig = excluded.sig`,
    [
      workoutId,
      athleteId,
      sig.lengthM,
      new Uint8Array(sig.pts.buffer, sig.pts.byteOffset, sig.pts.byteLength),
    ],
  );
  return true;
}

/** Signature from the stored blob (copied so the Float64Array is aligned). */
export function decodeSignature(blob: Uint8Array, lengthM: number): RouteSignature {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return { lengthM, pts: new Float64Array(copy.buffer) };
}

interface GeoRow {
  workout_id: number;
  length_m: number;
  sig: Uint8Array;
  route_id: number | null;
  sport: string;
}

function loadGeo(db: Db, athleteId: number): GeoRow[] {
  return all<GeoRow>(
    db,
    `SELECT g.workout_id, g.length_m, g.sig, g.route_id, w.sport
     FROM maps_workout_geo g JOIN workouts w ON w.id = g.workout_id
     WHERE g.athlete_id = ? ORDER BY w.start_ts, w.id`,
    [athleteId],
  );
}

/**
 * (Re)assign workouts to routes. `changed` = workouts to place (new / changed ones), or 'all' for a full rebuild.
 * New clusters take over the ids (and names) of the old routes they overlap with: in a full rebuild any old route of
 * the same sport, otherwise only one that lost all its unchanged members (it has no representative left, so its
 * changed members had to found a new cluster).
 */
export function clusterRoutes(db: Db, athleteId: number, changed: Set<number> | 'all'): void {
  const rows = loadGeo(db, athleteId);
  const full = changed === 'all';
  const isChanged = (id: number) => full || changed.has(id);

  // representatives of the routes that stay: the earliest unchanged member of each
  const reps = new Map<number, RouteRep>();
  const oldAssign = new Map<number, number | null>();
  for (const r of rows) {
    oldAssign.set(r.workout_id, r.route_id);
    if (isChanged(r.workout_id) || r.route_id === null || reps.has(r.route_id)) continue;
    reps.set(r.route_id, { id: r.route_id, sport: r.sport, sig: decodeSignature(r.sig, r.length_m) });
  }
  const todo: ShapedWorkout[] = rows
    .filter((r) => isChanged(r.workout_id))
    .map((r) => ({ id: r.workout_id, sport: r.sport, sig: decodeSignature(r.sig, r.length_m) }));
  const sportOf = new Map(rows.map((r) => [r.workout_id, r.sport]));
  const { assignment, founders } = assignRoutes([...reps.values()], todo);

  // the routes whose members changed: the old and the new route of every changed workout
  const touched = new Set<number>();
  tx(db, () => {
    const oldSport = new Map(
      all<{ id: number; sport: string }>(db, 'SELECT id, sport FROM maps_routes WHERE athlete_id = ?', [
        athleteId,
      ]).map((r) => [r.id, r.sport]),
    );
    // only new clusters (< 0) take over; a route that still has a representative keeps its members and id anyway
    const reuse = matchOldRoutes(
      assignment,
      oldAssign,
      (newId, oldId) =>
        newId < 0 && !reps.has(oldId) && oldSport.get(oldId) === sportOf.get(founders.get(newId)!),
    );
    const idOf = new Map<number, number>();
    const insert = prepare(db, 'INSERT INTO maps_routes (athlete_id, sport) VALUES (?, ?)');
    for (const [newId, founder] of founders) {
      const reused = reuse.get(newId);
      idOf.set(
        newId,
        reused !== undefined ? reused : Number(insert.run(athleteId, sportOf.get(founder)!).lastInsertRowid),
      );
    }
    const update = prepare(db, 'UPDATE maps_workout_geo SET route_id = ? WHERE workout_id = ?');
    for (const [workoutId, routeId] of assignment) {
      const id = routeId < 0 ? idOf.get(routeId)! : routeId;
      update.run(id, workoutId);
      touched.add(id);
      const old = oldAssign.get(workoutId);
      if (old != null) touched.add(old);
    }
    // marked for the refresh (see deleteShapes) together with the new assignment: the refresh runs in a transaction
    // of its own, and when it fails or never runs (the app quit in between) the next derive still catches up on these
    run(
      db,
      `UPDATE maps_routes SET rep_workout_id = NULL WHERE athlete_id = ?${full ? '' : ` AND id IN ${IN_LIST}`}`,
      full ? [athleteId] : [athleteId, idList([...touched])],
    );
  });
  refreshRoutes(db, athleteId, full ? undefined : touched);
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Recompute representative (earliest member), kind, area, length and display polyline of the routes: all of them, or
 * the routes `only` names plus the ones marked for a refresh (see deleteShapes). Drops routes without members.
 */
export function refreshRoutes(db: Db, athleteId: number, only?: Set<number>): void {
  const members = all<{ route_id: number; workout_id: number; length_m: number }>(
    db,
    `SELECT g.route_id, g.workout_id, g.length_m
     FROM maps_workout_geo g JOIN workouts w ON w.id = g.workout_id
     WHERE g.athlete_id = ? AND g.route_id IS NOT NULL${
       only
         ? ` AND g.route_id IN (SELECT value FROM json_each(?)
               UNION SELECT id FROM maps_routes WHERE athlete_id = ? AND rep_workout_id IS NULL)`
         : ''
     }
     ORDER BY g.route_id, w.start_ts, w.id`,
    only ? [athleteId, idList([...only]), athleteId] : [athleteId],
  );
  const lengths = new Map<number, number[]>();
  const repOf = new Map<number, number>();
  for (const m of members) {
    const l = lengths.get(m.route_id);
    if (l) l.push(m.length_m);
    else {
      lengths.set(m.route_id, [m.length_m]);
      repOf.set(m.route_id, m.workout_id);
    }
  }
  // shape, track and ends are only needed of the representatives
  const reps = new Map(
    (repOf.size
      ? all<{
          workout_id: number;
          length_m: number;
          sig: Uint8Array;
          polyline: string | null;
          start_lat: number | null;
          start_lon: number | null;
          end_lat: number | null;
          end_lon: number | null;
        }>(
          db,
          `SELECT g.workout_id, g.length_m, g.sig, w.polyline, w.start_lat, w.start_lon, w.end_lat, w.end_lon
           FROM maps_workout_geo g JOIN workouts w ON w.id = g.workout_id WHERE g.workout_id IN ${IN_LIST}`,
          [idList([...repOf.values()])],
        )
      : []
    ).map((r) => [r.workout_id, r]),
  );
  tx(db, () => {
    const upd = prepare(
      db,
      `UPDATE maps_routes SET rep_workout_id = ?, kind = ?, area = ?, area_end = ?, distance_m = ?, start_lat = ?,
         start_lon = ?, end_lat = ?, end_lon = ?, polyline = ? WHERE id = ? AND athlete_id = ?`,
    );
    for (const [routeId, members] of lengths) {
      const rep = reps.get(repOf.get(routeId)!)!;
      const kind = routeKind(decodeSignature(rep.sig, rep.length_m));
      // the nearest town / village / district of the start (offline gazetteer); a route from A to B names both
      const start = rep.start_lat !== null && rep.start_lon !== null ? nearestPlace(rep.start_lat, rep.start_lon) : null;
      const end =
        kind === 'point_to_point' && rep.end_lat !== null && rep.end_lon !== null
          ? nearestPlace(rep.end_lat, rep.end_lon)
          : null;
      upd.run(
        rep.workout_id,
        kind,
        start?.name ?? null,
        end && end.name !== start?.name ? end.name : null,
        Math.round(median(members)),
        rep.start_lat,
        rep.start_lon,
        rep.end_lat,
        rep.end_lon,
        rep.polyline,
        routeId,
        athleteId,
      );
    }
    run(
      db,
      `DELETE FROM maps_routes WHERE athlete_id = ?
         AND id NOT IN (SELECT DISTINCT route_id FROM maps_workout_geo WHERE route_id IS NOT NULL)`,
      [athleteId],
    );
  });
}

/** Group same-sport workouts that follow the same course into routes (incremental unless a full rebuild). */
export const routesStep: DeriveStep = {
  id: 'maps.routes',
  label: 'Repeated routes',
  weight: 1,
  run(ctx) {
    ctx.checkCancelled();
    clusterRoutes(ctx.db, ctx.athleteId, ctx.workoutIds === 'all' ? 'all' : new Set(ctx.workoutIds));
    ctx.report(1);
  },
};
