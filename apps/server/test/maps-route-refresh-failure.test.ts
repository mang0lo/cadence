import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { get, run } from '../src/db/db';
import { bounds, destination, encodePolylineArrays, simplifyIndices } from '../src/lib/geo';
import { gzipJson } from '../src/lib/gzip';
import {
  VIENNA,
  circle,
  insertWorkout,
  makeApp,
  runMapsSteps,
  trackAlong,
  type TestApp,
} from './maps-fixtures';

/** Lets the place lookup of the route refresh fail on demand (it runs after the new assignment was committed). */
const places = vi.hoisted(() => ({ fail: false }));
vi.mock('../src/lib/places', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/lib/places')>();
  return {
    ...orig,
    nearestPlace: (...args: Parameters<typeof orig.nearestPlace>) => {
      if (places.fail) throw new Error('place lookup failed');
      return orig.nearestPlace(...args);
    },
  };
});

/** A route refresh that fails after the workouts were assigned is caught up by the next (unrelated) derive. */
describe('route refresh after a failed derive', () => {
  let ctx: TestApp;
  const day = 86_400;
  const t0 = Date.UTC(2026, 6, 1, 7) / 1000;
  const NORTH = circle(destination(VIENNA[0], VIENNA[1], 0, 10_000), 600, 60);
  const SOUTH = circle(destination(VIENNA[0], VIENNA[1], 180, 10_000), 600, 60);
  const EAST = circle(destination(VIENNA[0], VIENNA[1], 90, 10_000), 600, 60);
  const ids: Record<string, number> = {};

  const routeOf = (workoutId: number) =>
    get<{ route_id: number }>(ctx.db, 'SELECT route_id FROM maps_workout_geo WHERE workout_id = ?', [
      workoutId,
    ])!.route_id;
  const repOf = (routeId: number) =>
    get<{ rep_workout_id: number | null }>(ctx.db, 'SELECT rep_workout_id FROM maps_routes WHERE id = ?', [
      routeId,
    ])!.rep_workout_id;

  beforeAll(async () => {
    ctx = await makeApp();
    const add = (key: string, d: number, points: typeof NORTH) => {
      ids[key] = insertWorkout(ctx.db, {
        sport: 'run',
        startTs: t0 + d * day,
        track: trackAlong(points, { speed: 3, noiseM: 2, seed: d * 13 }),
      });
    };
    add('n1', 1, NORTH);
    add('n2', 2, NORTH);
    add('s1', 3, SOUTH);
    add('s2', 4, SOUTH);
    add('other', 5, EAST);
    await runMapsSteps(ctx.db, 'all');
  }, 60_000);

  afterAll(async () => {
    places.fail = false;
    await ctx?.close();
  });

  it('refreshes the routes of a derive whose refresh failed with the next derive', async () => {
    const north = routeOf(ids.n1!);
    const south = routeOf(ids.s1!);
    expect(repOf(north)).toBe(ids.n1);
    expect(repOf(south)).toBe(ids.s1);
    // n1 is derived again with a track on the southern loop (a re-linked route) …
    const tr = trackAlong(SOUTH, { speed: 3, noiseM: 2, seed: 99 });
    const bb = bounds(tr.lat, tr.lon)!;
    run(
      ctx.db,
      `UPDATE workouts SET polyline = ?, min_lat = ?, min_lon = ?, max_lat = ?, max_lon = ?, start_lat = ?,
         start_lon = ?, end_lat = ?, end_lon = ? WHERE id = ?`,
      [
        encodePolylineArrays(tr.lat, tr.lon, simplifyIndices(tr.lat, tr.lon, 5)),
        bb[1],
        bb[0],
        bb[3],
        bb[2],
        tr.lat[0]!,
        tr.lon[0]!,
        tr.lat[tr.lat.length - 1]!,
        tr.lon[tr.lon.length - 1]!,
        ids.n1!,
      ],
    );
    run(ctx.db, 'UPDATE workout_streams SET data = ? WHERE workout_id = ?', [
      gzipJson({ t: tr.t, lat: tr.lat, lon: tr.lon, dist: tr.dist, ele: tr.ele, hr: tr.hr }),
      ids.n1!,
    ]);
    // … and the route refresh fails after the new assignment was stored
    places.fail = true;
    await expect(runMapsSteps(ctx.db, [ids.n1!], ['maps.geometry', 'maps.routes'])).rejects.toThrow(
      'place lookup failed',
    );
    places.fail = false;
    expect(routeOf(ids.n1!)).toBe(south);
    // the next derive is about a workout on another route; it still brings both routes up to date
    await runMapsSteps(ctx.db, [ids.other!], ['maps.geometry', 'maps.routes']);
    expect(repOf(north)).toBe(ids.n2);
    expect(repOf(south)).toBe(ids.n1);
  });
});
