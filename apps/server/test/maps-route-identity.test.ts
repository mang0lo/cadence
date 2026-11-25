import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MapsRouteDetail, MapsRouteSummary } from '@cadence/shared';
import { destination, type LatLon } from '../src/lib/geo';
import { VIENNA, circle, insertWorkout, makeApp, runMapsSteps, trackAlong, type TestApp } from './maps-fixtures';

/** Route ids and names survive incremental derives (hide toggles, sport fixes, re-linked imports). */
describe('route identity across incremental derives', () => {
  let ctx: TestApp;
  const day = 86_400;
  const t0 = Date.UTC(2026, 4, 4, 7) / 1000;
  let n = 0;

  const loopAt = (bearing: number, km: number): LatLon[] =>
    circle(destination(VIENNA[0], VIENNA[1], bearing, km * 1000), 600, 60);
  const SOLO = loopAt(0, 10);
  const TRIO = loopAt(90, 10);
  const PAIR = loopAt(180, 10);
  const SINGLE = loopAt(270, 10);

  const addRun = (points: LatLon[]) => {
    n++;
    return insertWorkout(ctx.db, {
      sport: 'run',
      startTs: t0 + n * day,
      track: trackAlong(points, { speed: 3 + n * 0.01, noiseM: 3, seed: n * 11 }),
    });
  };
  const routeOf = (workoutId: number) =>
    (ctx.db.prepare('SELECT route_id FROM maps_workout_geo WHERE workout_id = ?').get(workoutId) as {
      route_id: number | null;
    }).route_id!;
  const nameOf = (routeId: number) =>
    (ctx.db.prepare('SELECT custom_name FROM maps_routes WHERE id = ?').get(routeId) as
      | { custom_name: string | null }
      | undefined)?.custom_name;
  const rename = async (routeId: number, name: string) => {
    const res = await ctx.app.inject({ method: 'PATCH', url: `/api/maps/routes/${routeId}`, payload: { name } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<MapsRouteSummary>();
  };
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ctx = await makeApp();
    ids.solo = addRun(SOLO);
    ids.trio1 = addRun(TRIO);
    ids.trio2 = addRun(TRIO);
    ids.trio3 = addRun(TRIO);
    ids.pair1 = addRun(PAIR);
    ids.pair2 = addRun(PAIR);
    ids.single = addRun(SINGLE);
    await runMapsSteps(ctx.db, 'all');
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('keeps id and name of a one-workout route when that workout is hidden and shown again', async () => {
    const id = routeOf(ids.solo);
    await rename(id, 'Hill loop');
    ctx.db.prepare('UPDATE workouts SET hidden = 1 WHERE id = ?').run(ids.solo);
    await runMapsSteps(ctx.db, [ids.solo]);
    expect(routeOf(ids.solo)).toBe(id);
    expect(nameOf(id)).toBe('Hill loop');
    ctx.db.prepare('UPDATE workouts SET hidden = 0 WHERE id = ?').run(ids.solo);
    await runMapsSteps(ctx.db, [ids.solo]);
    const res = await ctx.app.inject({ url: `/api/maps/routes/${id}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<MapsRouteDetail>().route.customName).toBe('Hill loop');
  });

  it('keeps id and name when every member of a route is derived again in one job', async () => {
    const id = routeOf(ids.trio1);
    expect(routeOf(ids.trio2)).toBe(id);
    expect(routeOf(ids.trio3)).toBe(id);
    await rename(id, 'Danube three');
    await runMapsSteps(ctx.db, [ids.trio1, ids.trio2, ids.trio3]);
    for (const w of [ids.trio1, ids.trio2, ids.trio3]) expect(routeOf(w)).toBe(id);
    expect(nameOf(id)).toBe('Danube three');
  });

  it('lets a new cluster take over its old route even when a moved workout joined another route', async () => {
    // single was on route S; pretend pair1 used to belong to S as well (its track changed since)
    const pairRoute = routeOf(ids.pair1);
    const singleRoute = routeOf(ids.single);
    await rename(singleRoute, 'Lonely loop');
    ctx.db.prepare('UPDATE maps_workout_geo SET route_id = ? WHERE workout_id = ?').run(singleRoute, ids.pair1);
    // pair1 goes back to the pair route (pair2 is unchanged), single founds a cluster that takes S over again
    await runMapsSteps(ctx.db, [ids.pair1, ids.single]);
    expect(routeOf(ids.pair1)).toBe(pairRoute);
    expect(routeOf(ids.single)).toBe(singleRoute);
    expect(nameOf(singleRoute)).toBe('Lonely loop');
  });

  it('does not hand a route over to another sport', async () => {
    const id = routeOf(ids.solo);
    ctx.db.prepare("UPDATE workouts SET sport = 'walk' WHERE id = ?").run(ids.solo);
    await runMapsSteps(ctx.db, [ids.solo]);
    const walkRoute = routeOf(ids.solo);
    expect(walkRoute).not.toBe(id);
    expect(nameOf(walkRoute)).toBeNull();
    // the run route had no other member: it is gone
    expect(nameOf(id)).toBeUndefined();
  });
});
