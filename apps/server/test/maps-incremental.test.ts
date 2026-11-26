import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MapsSegmentDetail } from '@cadence/shared';
import { get, run } from '../src/db/db';
import { gzipJson } from '../src/lib/gzip';
import { destination, type LatLon } from '../src/lib/geo';
import { VIENNA, insertWorkout, makeApp, runMapsSteps, trackAlong, type TestApp } from './maps-fixtures';

const ROAD: LatLon[] = [VIENNA, destination(VIENNA[0], VIENNA[1], 90, 3000)];

describe('maps steps on an incremental derive', () => {
  let ctx: TestApp;
  const ids: number[] = [];

  const count = (sql: string, id: number) => get<{ n: number }>(ctx.db, sql, [id])!.n;
  const tiles = (id: number) => count('SELECT COUNT(*) AS n FROM maps_workout_tiles WHERE workout_id = ?', id);
  const geo = (id: number) => count('SELECT COUNT(*) AS n FROM maps_workout_geo WHERE workout_id = ?', id);

  beforeAll(async () => {
    ctx = await makeApp();
    const t0 = Date.UTC(2026, 3, 1, 7) / 1000;
    for (let n = 0; n < 4; n++)
      ids.push(
        insertWorkout(ctx.db, {
          sport: 'run',
          startTs: t0 + n * 86_400,
          track: trackAlong(ROAD, { speed: 3 + n * 0.1, noiseM: 3, seed: n + 1 }),
        }),
      );
    await runMapsSteps(ctx.db, 'all');
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('drops tiles and shape of a workout that lost its route and keeps the others', async () => {
    const [lost, kept] = ids as [number, number];
    expect(tiles(lost)).toBeGreaterThan(0);
    expect(geo(lost)).toBe(1);
    // re-derived without GPS (e.g. the route was unlinked): no route, a stream without coordinates
    run(ctx.db, 'UPDATE workouts SET has_route = 0, polyline = NULL WHERE id = ?', [lost]);
    run(ctx.db, 'UPDATE workout_streams SET data = ? WHERE workout_id = ?', [gzipJson({ t: [1, 2], hr: [120, 121] }), lost]);
    const keptTiles = tiles(kept);
    await runMapsSteps(ctx.db, [lost, kept], ['maps.geometry']);
    expect(tiles(lost)).toBe(0);
    expect(geo(lost)).toBe(0);
    expect(tiles(kept)).toBe(keptTiles);
    expect(geo(kept)).toBe(1);
  });

  it('matches segments for more changed workouts than SQLite takes parameters', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/maps/segments',
      payload: { workoutId: ids[1], startM: 500, endM: 2500, name: 'Road' },
    });
    expect(res.statusCode).toBe(201);
    const segmentId = res.json<MapsSegmentDetail>().segment.id;
    run(ctx.db, 'DELETE FROM maps_segment_efforts');
    // a first import after "delete all data" (segments are kept) can bring more workouts than SQLite takes
    // parameters (32 766 by default, 250 000 in node:sqlite)
    const changed = [...ids, ...Array.from({ length: 260_000 }, (_, i) => 1_000_000 + i)];
    await runMapsSteps(ctx.db, changed, ['maps.segments']);
    expect(count('SELECT COUNT(*) AS n FROM maps_segment_efforts WHERE segment_id = ?', segmentId)).toBe(3);
  });
});
