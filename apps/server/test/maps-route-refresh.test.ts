import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { get, run } from '../src/db/db';
import { bounds, destination, encodePolylineArrays, simplifyIndices, type LatLon } from '../src/lib/geo';
import { gzipJson } from '../src/lib/gzip';
import {
  VIENNA,
  circle,
  insertWorkout,
  makeApp,
  runMapsSteps,
  trackAlong,
  type TestApp,
  type TestTrack,
} from './maps-fixtures';

/** Representative, length and track of a route follow its members, also when only some workouts are derived again. */
describe('route refresh on incremental derives', () => {
  let ctx: TestApp;
  const day = 86_400;
  const t0 = Date.UTC(2026, 6, 1, 7) / 1000;
  const NORTH = circle(destination(VIENNA[0], VIENNA[1], 0, 10_000), 600, 60);
  const SOUTH = circle(destination(VIENNA[0], VIENNA[1], 180, 10_000), 600, 60);
  const ids: Record<string, number> = {};
  let n = 0;

  const track = (points: LatLon[], stretch = 1): TestTrack => {
    n++;
    const tr = trackAlong(points, { speed: 3, noiseM: 2, seed: n * 17 });
    // a GPS distance that over-measures the same course: same shape, longer route
    return { ...tr, dist: tr.dist.map((d) => Math.round(d * stretch * 10) / 10) };
  };
  const add = (key: string, d: number, tr: TestTrack) => {
    ids[key] = insertWorkout(ctx.db, { sport: 'run', startTs: t0 + d * day, track: tr });
  };
  /** Replace a workout's GPS track the way a re-derive of the workout would. */
  const setTrack = (id: number, tr: TestTrack) => {
    const bb = bounds(tr.lat, tr.lon)!;
    run(
      ctx.db,
      `UPDATE workouts SET polyline = ?, distance_m = ?, min_lat = ?, min_lon = ?, max_lat = ?, max_lon = ?,
         start_lat = ?, start_lon = ?, end_lat = ?, end_lon = ? WHERE id = ?`,
      [
        encodePolylineArrays(tr.lat, tr.lon, simplifyIndices(tr.lat, tr.lon, 5)),
        tr.dist[tr.dist.length - 1]!,
        bb[1],
        bb[0],
        bb[3],
        bb[2],
        tr.lat[0]!,
        tr.lon[0]!,
        tr.lat[tr.lat.length - 1]!,
        tr.lon[tr.lon.length - 1]!,
        id,
      ],
    );
    run(ctx.db, 'UPDATE workout_streams SET data = ? WHERE workout_id = ?', [
      gzipJson({ t: tr.t, lat: tr.lat, lon: tr.lon, dist: tr.dist, ele: tr.ele, hr: tr.hr }),
      id,
    ]);
  };
  /** Re-derived without GPS (e.g. the route was unlinked): no route, a stream without coordinates. */
  const loseRoute = (id: number) => {
    run(ctx.db, 'UPDATE workouts SET has_route = 0, polyline = NULL WHERE id = ?', [id]);
    run(ctx.db, 'UPDATE workout_streams SET data = ? WHERE workout_id = ?', [gzipJson({ t: [1, 2], hr: [120, 121] }), id]);
  };
  const routeOf = (workoutId: number) =>
    get<{ route_id: number }>(ctx.db, 'SELECT route_id FROM maps_workout_geo WHERE workout_id = ?', [workoutId])!
      .route_id;
  const route = (id: number) =>
    get<{ rep_workout_id: number; distance_m: number; polyline: string; area: string | null }>(
      ctx.db,
      'SELECT rep_workout_id, distance_m, polyline, area FROM maps_routes WHERE id = ?',
      [id],
    )!;
  const polylineOf = (workoutId: number) =>
    get<{ polyline: string }>(ctx.db, 'SELECT polyline FROM workouts WHERE id = ?', [workoutId])!.polyline;
  const lengthOf = (workoutId: number) =>
    get<{ length_m: number }>(ctx.db, 'SELECT length_m FROM maps_workout_geo WHERE workout_id = ?', [workoutId])!
      .length_m;

  beforeAll(async () => {
    ctx = await makeApp();
    add('n1', 1, track(NORTH));
    add('n2', 2, track(NORTH, 1.08));
    add('n3', 3, track(NORTH));
    add('s1', 4, track(SOUTH));
    add('s2', 5, track(SOUTH));
    await runMapsSteps(ctx.db, 'all');
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('recomputes the routes of the changed workouts and leaves the others alone', async () => {
    const north = routeOf(ids.n1!);
    const south = routeOf(ids.s1!);
    expect(new Set([ids.n2, ids.n3].map((id) => routeOf(id!)))).toEqual(new Set([north]));
    expect(routeOf(ids.s2!)).toBe(south);
    expect(route(north).rep_workout_id).toBe(ids.n1);
    // median of the three lengths: n2 is the longest
    expect(route(north).distance_m).toBe(Math.round(Math.max(lengthOf(ids.n1!), lengthOf(ids.n3!))));
    run(ctx.db, "UPDATE maps_routes SET area = 'stale' WHERE id IN (?, ?)", [north, south]);
    await runMapsSteps(ctx.db, [ids.n2!]);
    expect(route(north).area).not.toBe('stale');
    expect(route(south).area).toBe('stale'); // untouched by this derive
    await runMapsSteps(ctx.db, 'all');
    expect(route(south).area).not.toBe('stale'); // a full rebuild refreshes every route
  });

  it('gives a route a new representative when its first member moved to another route', async () => {
    const north = routeOf(ids.n1!);
    const south = routeOf(ids.s1!);
    setTrack(ids.n1!, track(SOUTH));
    await runMapsSteps(ctx.db, [ids.n1!]);
    expect(routeOf(ids.n1!)).toBe(south);
    // north: n2 is its earliest member now; south: n1 is earlier than s1
    expect(route(north)).toMatchObject({ rep_workout_id: ids.n2, polyline: polylineOf(ids.n2!) });
    expect(route(north).distance_m).toBe(Math.round((lengthOf(ids.n2!) + lengthOf(ids.n3!)) / 2));
    expect(route(south)).toMatchObject({ rep_workout_id: ids.n1, polyline: polylineOf(ids.n1!) });
  });

  it('refreshes a route that lost a member without a route left', async () => {
    const north = routeOf(ids.n2!);
    const keep = lengthOf(ids.n2!);
    expect(Math.abs(route(north).distance_m - keep)).toBeGreaterThan(100);
    // n3 is derived again without GPS: its shape is gone, the route has one member left
    loseRoute(ids.n3!);
    await runMapsSteps(ctx.db, [ids.n3!]);
    expect(route(north).distance_m).toBe(Math.round(keep));
    // n2 loses its route too: the route has no member left and goes
    loseRoute(ids.n2!);
    await runMapsSteps(ctx.db, [ids.n2!]);
    expect(get(ctx.db, 'SELECT id FROM maps_routes WHERE id = ?', [north])).toBeUndefined();
  });
});
