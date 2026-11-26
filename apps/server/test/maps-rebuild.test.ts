import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancelledError } from '../src/derive/context';
import { geometryStep } from '../src/features/maps/geometry';
import type { DeriveContext } from '../src/features/types';
import { destination } from '../src/lib/geo';
import { VIENNA, insertWorkout, line, makeApp, runMapsSteps, trackAlong, type TestApp } from './maps-fixtures';

/** A derive context like the import worker's; `cancelAfter` lets checkCancelled throw on its n-th call. */
function deriveCtx(db: TestApp['db'], workoutIds: number[] | 'all', cancelAfter = Infinity): DeriveContext {
  let calls = 0;
  return {
    db,
    athleteId: 1,
    workoutIds,
    sinceDay: null,
    report: () => {},
    checkCancelled: () => {
      if (++calls > cancelAfter) throw new CancelledError();
    },
    log: () => {},
  };
}

const runStep = async (c: DeriveContext) => {
  await geometryStep.run(c);
};

const count = (db: TestApp['db'], sql: string, ...params: number[]) =>
  (db.prepare(sql).get(...params) as { n: number }).n;

describe('maps.geometry: a cancelled full rebuild', () => {
  let ctx: TestApp;
  const ids: number[] = [];

  beforeAll(async () => {
    ctx = await makeApp();
    // 45 short runs on different streets (three batches of the geometry step)
    for (let i = 0; i < 45; i++) {
      const from = destination(VIENNA[0], VIENNA[1], 180, i * 400);
      ids.push(
        insertWorkout(ctx.db, {
          sport: 'run',
          startTs: 1_700_000_000 + i * 86_400,
          track: trackAlong(line(from, 1200), { speed: 4 }),
        }),
      );
    }
    await runMapsSteps(ctx.db, 'all');
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('keeps the tiles of every workout it did not reach', async () => {
    const tilesBefore = count(ctx.db, 'SELECT COUNT(*) AS n FROM maps_workout_tiles');
    const withTiles = count(ctx.db, 'SELECT COUNT(DISTINCT workout_id) AS n FROM maps_workout_tiles');
    expect(withTiles).toBe(ids.length);
    // cancelled after the first batch of 20 workouts
    await expect(runStep(deriveCtx(ctx.db, 'all', 1))).rejects.toThrow(CancelledError);
    expect(count(ctx.db, 'SELECT COUNT(DISTINCT workout_id) AS n FROM maps_workout_tiles')).toBe(ids.length);
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM maps_workout_tiles')).toBe(tilesBefore);
  });

  it('still drops the tiles of workouts that lost their route in a full rebuild', async () => {
    const gone = ids[30]!;
    ctx.db.prepare('UPDATE workouts SET has_route = 0 WHERE id = ?').run(gone);
    await runStep(deriveCtx(ctx.db, 'all'));
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM maps_workout_tiles WHERE workout_id = ?', gone)).toBe(0);
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM maps_workout_geo WHERE workout_id = ?', gone)).toBe(0);
    expect(count(ctx.db, 'SELECT COUNT(DISTINCT workout_id) AS n FROM maps_workout_tiles')).toBe(ids.length - 1);
  });
});
