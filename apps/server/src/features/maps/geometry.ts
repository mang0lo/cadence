import { getStreams } from '../../core/workouts';
import { all, prepare, run, tx, type Db } from '../../db/db';
import type { DeriveStep } from '../types';
import { deleteShapes, storeSignature } from './route-derive';
import { IN_LIST, idList } from './sql';
import { coarsen, keyX, keyY, tileCover } from './tiles';

export const TILE_ZOOMS = [14, 17] as const;

/** Replace the stored tiles of a workout (zoom 14 and 17) with the tiles its track passes through. */
export function storeTiles(
  db: Db,
  athleteId: number,
  workoutId: number,
  lat: ArrayLike<number> | undefined,
  lon: ArrayLike<number> | undefined,
  breaks?: ArrayLike<number>,
): number {
  run(db, 'DELETE FROM maps_workout_tiles WHERE workout_id = ?', [workoutId]);
  if (!lat || !lon || lat.length < 2) return 0;
  // One pass at the finest zoom (gap-filled, but never across a break in the track); coarser tiles are its parents.
  const fine = tileCover(lat, lon, 17, { breaks });
  const coarse = coarsen(fine, 3);
  const ins = prepare(
    db,
    'INSERT OR IGNORE INTO maps_workout_tiles (athlete_id, z, x, y, workout_id) VALUES (?, ?, ?, ?, ?)',
  );
  for (const k of coarse) ins.run(athleteId, 14, keyX(k), keyY(k), workoutId);
  for (const k of fine) ins.run(athleteId, 17, keyX(k), keyY(k), workoutId);
  return coarse.size;
}

/** Ids of the athlete's workouts that have a GPS route (hidden and duplicate ones included, see migration). */
export function routeWorkoutIds(db: Db, athleteId: number): number[] {
  return all<{ id: number }>(
    db,
    'SELECT id FROM workouts WHERE athlete_id = ? AND has_route = 1 ORDER BY start_ts, id',
    [athleteId],
  ).map((r) => r.id);
}

/**
 * Per-workout geometry from the stored GPS stream, decoded once: explorer tiles and the route-shape signature
 * (the routes step clusters the signatures afterwards).
 */
export const geometryStep: DeriveStep = {
  id: 'maps.geometry',
  label: 'Map tiles and route shapes',
  weight: 3,
  run(ctx) {
    const { db, athleteId } = ctx;
    let ids: number[];
    if (ctx.workoutIds !== 'all') {
      // only workouts with a route have tiles and a shape; the others just lose theirs, without decoding a stream
      const changed = idList(ctx.workoutIds);
      const noRoute = `workout_id IN ${IN_LIST} AND workout_id NOT IN (SELECT id FROM workouts WHERE has_route = 1)`;
      run(db, `DELETE FROM maps_workout_tiles WHERE athlete_id = ? AND ${noRoute}`, [athleteId, changed]);
      deleteShapes(db, `athlete_id = ? AND ${noRoute}`, [athleteId, changed]);
      ids = all<{ id: number }>(
        db,
        `SELECT id FROM workouts WHERE athlete_id = ? AND has_route = 1 AND id IN ${IN_LIST} ORDER BY start_ts, id`,
        [athleteId, changed],
      ).map((r) => r.id);
    } else {
      ids = routeWorkoutIds(db, athleteId);
      // tiles are replaced per workout and signatures upserted (keeping route ids for the rebuild) below, batch by
      // batch: a cancelled or failed rebuild keeps the rows of the workouts it did not reach. Only the rows of
      // workouts without a route have to go here.
      run(
        db,
        `DELETE FROM maps_workout_tiles WHERE athlete_id = ?
           AND workout_id NOT IN (SELECT id FROM workouts WHERE athlete_id = ? AND has_route = 1)`,
        [athleteId, athleteId],
      );
      deleteShapes(db, 'athlete_id = ? AND workout_id NOT IN (SELECT id FROM workouts WHERE has_route = 1)', [
        athleteId,
      ]);
    }
    const BATCH = 20;
    for (let i = 0; i < ids.length; i += BATCH) {
      ctx.checkCancelled();
      const slice = ids.slice(i, i + BATCH);
      tx(db, () => {
        for (const id of slice) {
          const s = getStreams(db, athleteId, id);
          storeTiles(db, athleteId, id, s?.lat, s?.lon, s?.breaks);
          // a track in several parts (travelled while paused) is no repeatable course
          if (s?.breaks?.length) storeSignature(db, athleteId, id, undefined, undefined, undefined);
          else storeSignature(db, athleteId, id, s?.lat, s?.lon, s?.dist);
        }
      });
      ctx.report(
        Math.min(1, (i + slice.length) / Math.max(1, ids.length)),
        `${Math.min(ids.length, i + BATCH)} / ${ids.length}`,
      );
    }
  },
};
