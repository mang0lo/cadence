import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { all, get, run } from '../src/db/db';
import { createSegment } from '../src/features/maps/segments';
import { destination, type LatLon } from '../src/lib/geo';
import { VIENNA, insertWorkout, makeApp, runMapsSteps, trackAlong, type TestApp } from './maps-fixtures';

const ROAD: LatLon[] = [VIENNA, destination(VIENNA[0], VIENNA[1], 90, 3000)];

describe('segments: creating one does not hold up other requests', () => {
  let ctx: TestApp;
  const ids: number[] = [];

  const efforts = (segmentId: number) =>
    all<{ workout_id: number; idx: number; elapsed_s: number }>(
      ctx.db,
      'SELECT workout_id, idx, elapsed_s FROM maps_segment_efforts WHERE segment_id = ? ORDER BY workout_id, idx',
      [segmentId],
    );

  beforeAll(async () => {
    ctx = await makeApp();
    const t0 = Date.UTC(2026, 3, 1, 7) / 1000;
    for (let n = 0; n < 12; n++)
      ids.push(
        insertWorkout(ctx.db, {
          sport: 'run',
          startTs: t0 + n * 86_400,
          track: trackAlong(ROAD, { speed: 2.8 + n * 0.05, noiseM: 3, seed: n + 1 }),
        }),
      );
    await runMapsSteps(ctx.db, 'all');
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('matches in slices and lets the event loop run in between', async () => {
    const order: string[] = [];
    const created = createSegment(ctx.db, 1, { workoutId: ids[0]!, startM: 500, endM: 2500, name: 'Sliced' }, { sliceMs: 0 });
    // queued after the creation started: runs while the segment is still being matched
    setImmediate(() => order.push('other request'));
    const id = await created;
    order.push('created');
    expect(order).toEqual(['other request', 'created']);
    // the same efforts as the derive step stores
    const sliced = efforts(id);
    expect(sliced.length).toBe(ids.length);
    await runMapsSteps(ctx.db, 'all', ['maps.segments']);
    expect(efforts(id)).toEqual(sliced);
  });

  it('stops quietly when the segment is deleted while it is matched', async () => {
    const created = createSegment(ctx.db, 1, { workoutId: ids[0]!, startM: 200, endM: 1800, name: 'Doomed' }, { sliceMs: 0 });
    const row = get<{ id: number }>(ctx.db, "SELECT id FROM maps_segments WHERE name = 'Doomed'")!;
    setImmediate(() => run(ctx.db, 'DELETE FROM maps_segments WHERE id = ?', [row.id]));
    await expect(created).resolves.toBe(row.id);
    expect(efforts(row.id)).toEqual([]);
    const res = await ctx.app.inject({ url: `/api/maps/segments/${row.id}` });
    expect(res.statusCode).toBe(404);
  });
});
