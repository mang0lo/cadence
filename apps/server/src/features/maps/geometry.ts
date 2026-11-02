import { getStreams } from '../../core/workouts';
import { all, prepare, run, tx, type Db } from '../../db/db';
import type { DeriveStep } from '../types';
import { coarsen, keyX, keyY, tileCover } from './tiles';

export const TILE_ZOOMS = [14, 17] as const;

/** Replace the stored tiles of a workout (zoom 14 and 17) with the tiles its track passes through. */
export function storeTiles(
  db: Db,
  athleteId: number,
  workoutId: number,
  lat: ArrayLike<number> | undefined,
  lon: ArrayLike<number> | undefined,
): number {
  run(db, 'DELETE FROM maps_workout_tiles WHERE workout_id = ?', [workoutId]);
  if (!lat || !lon || lat.length < 2) return 0;
  // One pass at the finest zoom (gap-filled); the coarser tiles are its parents.
  const fine = tileCover(lat, lon, 17);
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
 * Per-workout geometry from the stored GPS stream: explorer tiles. (Route shapes are added by the routes module
 * so each stream is only decoded once.)
 */
export const geometryStep: DeriveStep = {
  id: 'maps.geometry',
  label: 'Map tiles and route shapes',
  weight: 3,
  run(ctx) {
    const { db, athleteId } = ctx;
    const ids = ctx.workoutIds === 'all' ? routeWorkoutIds(db, athleteId) : ctx.workoutIds;
    if (ctx.workoutIds === 'all') run(db, 'DELETE FROM maps_workout_tiles WHERE athlete_id = ?', [athleteId]);
    const BATCH = 20;
    for (let i = 0; i < ids.length; i += BATCH) {
      ctx.checkCancelled();
      const slice = ids.slice(i, i + BATCH);
      tx(db, () => {
        for (const id of slice) {
          const s = getStreams(db, athleteId, id);
          storeTiles(db, athleteId, id, s?.lat, s?.lon);
        }
      });
      ctx.report(Math.min(1, (i + slice.length) / Math.max(1, ids.length)), `${Math.min(ids.length, i + BATCH)} / ${ids.length}`);
    }
  },
};
