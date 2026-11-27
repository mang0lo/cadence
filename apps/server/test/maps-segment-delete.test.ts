import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MapsSegmentDetail } from '@cadence/shared';
import { get, run } from '../src/db/db';
import { segmentsStep } from '../src/features/maps/segments';
import type { DeriveContext } from '../src/features/types';
import { destination, type LatLon } from '../src/lib/geo';
import { VIENNA, insertWorkout, makeApp, runMapsSteps, trackAlong, type TestApp } from './maps-fixtures';

const ROAD: LatLon[] = [VIENNA, destination(VIENNA[0], VIENNA[1], 90, 3000)];

describe('segments: one is deleted while the derive step matches', () => {
  let ctx: TestApp;
  const ids: number[] = [];
  let first = 0;
  let second = 0;

  const effortsOf = (segmentId: number) =>
    get<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM maps_segment_efforts WHERE segment_id = ?', [segmentId])!
      .n;

  beforeAll(async () => {
    ctx = await makeApp();
    const t0 = Date.UTC(2026, 3, 1, 7) / 1000;
    // more workouts than one batch of the step (25)
    for (let n = 0; n < 32; n++)
      ids.push(
        insertWorkout(ctx.db, {
          sport: 'run',
          startTs: t0 + n * 86_400,
          track: trackAlong(ROAD, { speed: 2.8 + n * 0.02, noiseM: 3, seed: n + 1 }),
        }),
      );
    await runMapsSteps(ctx.db, 'all');
    const create = async (startM: number, endM: number, name: string) => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/maps/segments',
        payload: { workoutId: ids[0], startM, endM, name },
      });
      expect(res.statusCode).toBe(201);
      return res.json<MapsSegmentDetail>().segment.id;
    };
    first = await create(200, 1200, 'First');
    second = await create(1500, 2800, 'Second');
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('keeps matching the other segments for every workout', async () => {
    expect(effortsOf(first)).toBe(ids.length);
    expect(effortsOf(second)).toBe(ids.length);
    run(ctx.db, 'DELETE FROM maps_segment_efforts');
    let deleted = false;
    const step: DeriveContext = {
      db: ctx.db,
      athleteId: 1,
      workoutIds: 'all',
      sinceDay: null,
      // the user deletes the first segment while the step is between two batches
      report: () => {
        if (deleted) return;
        deleted = true;
        run(ctx.db, 'DELETE FROM maps_segments WHERE id = ?', [first]);
      },
      checkCancelled: () => {},
      log: () => {},
    };
    await segmentsStep.run(step);
    expect(deleted).toBe(true);
    expect(effortsOf(first)).toBe(0);
    expect(effortsOf(second)).toBe(ids.length);
  });

  it('does not match a new segment that got the id of a deleted one against the old course', async () => {
    run(ctx.db, 'DELETE FROM maps_segment_efforts');
    const old = get<Record<string, unknown>>(ctx.db, 'SELECT * FROM maps_segments WHERE id = ?', [second])!;
    let replaced = false;
    const step: DeriveContext = {
      db: ctx.db,
      athleteId: 1,
      workoutIds: 'all',
      sinceDay: null,
      // the user deletes the newest segment and creates another one, which gets the same id (SQLite reuses the
      // highest rowid); its own creation matches it, the running step must not do so with the deleted course
      report: () => {
        if (replaced) return;
        replaced = true;
        run(ctx.db, 'DELETE FROM maps_segments WHERE id = ?', [second]);
        const row = { ...old, name: 'Reborn', created_at: Number(old.created_at) + 1 };
        const cols = Object.keys(row);
        run(
          ctx.db,
          `INSERT INTO maps_segments (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          Object.values(row),
        );
      },
      checkCancelled: () => {},
      log: () => {},
    };
    await segmentsStep.run(step);
    expect(replaced).toBe(true);
    expect(get(ctx.db, 'SELECT name FROM maps_segments WHERE id = ?', [second])).toEqual({ name: 'Reborn' });
    expect(effortsOf(second)).toBe(0);
  });
});
