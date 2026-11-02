import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MapsRouteDetail, MapsRouteSummary, MapsRoutesResponse } from '@cadence/shared';
import { destination, haversine, type LatLon } from '../src/lib/geo';
import {
  LENGTH_TOLERANCE,
  MIN_ROUTE_M,
  SIG_POINTS,
  areaFromTimezone,
  assignRoutes,
  compareSignatures,
  makeSignature,
  matchOldRoutes,
  routeKind,
  shapeTolerance,
  type RouteSignature,
} from '../src/features/maps/route-shapes';
import { VIENNA, circle, insertWorkout, line, makeApp, runMapsSteps, trackAlong, type TestApp } from './maps-fixtures';

const sigOf = (points: LatLon[], opts: Parameters<typeof trackAlong>[1] = {}): RouteSignature => {
  const tr = trackAlong(points, { speed: 3, ...opts });
  return makeSignature(tr.lat, tr.lon, tr.dist)!;
};

const LOOP = circle(VIENNA, 800, 72); // ≈ 5 km
const LOOP_REVERSED = circle(VIENNA, 800, 72, false);
const OTHER_CENTER: LatLon = destination(VIENNA[0], VIENNA[1], 90, 4000);

describe('makeSignature', () => {
  it('resamples a track at equal fractions of its length', () => {
    const tr = trackAlong(line(VIENNA, 1000), { speed: 2 });
    const sig = makeSignature(tr.lat, tr.lon, tr.dist)!;
    expect(sig.pts.length).toBe(2 * SIG_POINTS);
    expect(sig.lengthM).toBeCloseTo(1000, -1);
    const at = (k: number): LatLon => [sig.pts[2 * k]!, sig.pts[2 * k + 1]!];
    expect(haversine(...at(0), tr.lat[0]!, tr.lon[0]!)).toBeLessThan(1);
    expect(haversine(...at(SIG_POINTS - 1), tr.lat[tr.lat.length - 1]!, tr.lon[tr.lon.length - 1]!)).toBeLessThan(1);
    // equal spacing along the line
    const step = haversine(...at(0), ...at(1));
    expect(step).toBeCloseTo(1000 / (SIG_POINTS - 1), 0);
    expect(haversine(...at(10), ...at(11))).toBeCloseTo(step, 0);
  });

  it('works without a distance stream and rejects tiny tracks', () => {
    const tr = trackAlong(line(VIENNA, 2000), { speed: 4 });
    const a = makeSignature(tr.lat, tr.lon)!;
    const b = makeSignature(tr.lat, tr.lon, tr.dist)!;
    expect(a.lengthM).toBeCloseTo(b.lengthM, -1);
    const short = trackAlong(line(VIENNA, MIN_ROUTE_M - 100), { speed: 2 });
    expect(makeSignature(short.lat, short.lon, short.dist)).toBeNull();
    expect(makeSignature([48], [16])).toBeNull();
    expect(makeSignature([], [])).toBeNull();
  });
});

describe('compareSignatures', () => {
  it('matches the same loop recorded twice with GPS noise', () => {
    const a = sigOf(LOOP, { noiseM: 5, seed: 1 });
    const b = sigOf(LOOP, { noiseM: 5, seed: 2 });
    const r = compareSignatures(a, b);
    expect(r.match).toBe(true);
    expect(r.mean!).toBeLessThan(shapeTolerance(a.lengthM));
  });

  it('keeps the two directions of a loop apart', () => {
    const cw = sigOf(LOOP, { noiseM: 4, seed: 3 });
    const ccw = sigOf(LOOP_REVERSED, { noiseM: 4, seed: 4 });
    expect(compareSignatures(cw, ccw)).toMatchObject({ match: false, reason: 'shape' });
  });

  it('treats an out-and-back as its own reverse', () => {
    const there = line(VIENNA, 2500);
    const outAndBack = [...there, ...[...there].reverse().slice(1)];
    const a = sigOf(outAndBack, { noiseM: 4, seed: 5 });
    const b = sigOf(outAndBack, { noiseM: 4, seed: 6 });
    expect(compareSignatures(a, b).match).toBe(true);
  });

  it('rejects other lengths, other starts, other ends and parallel routes', () => {
    const base = sigOf(LOOP, { seed: 7 });
    const bigger = sigOf(circle(VIENNA, 800 * (1 + LENGTH_TOLERANCE + 0.08), 72), { seed: 8 });
    expect(compareSignatures(base, bigger)).toMatchObject({ match: false, reason: 'length' });

    // same shape but starting 300 m away (shift the whole loop)
    const shifted = sigOf(circle(destination(VIENNA[0], VIENNA[1], 0, 300), 800, 72), { seed: 9 });
    expect(compareSignatures(base, shifted).match).toBe(false);

    // straight route; the other one ends 400 m further to the side
    const straight = sigOf(line(VIENNA, 5000), { seed: 10 });
    const bent = sigOf([...line(VIENNA, 4900), destination(...destination(VIENNA[0], VIENNA[1], 90, 4900), 0, 400)], { seed: 11 });
    expect(compareSignatures(straight, bent).match).toBe(false);

    // parallel street 150 m away over 10 km: same start and end region is impossible → shift only the middle
    const start = VIENNA;
    const end = destination(VIENNA[0], VIENNA[1], 90, 10_000);
    const mid1 = destination(VIENNA[0], VIENNA[1], 90, 5000);
    const direct = sigOf([start, mid1, end], { seed: 12 });
    const detour = sigOf([start, destination(mid1[0], mid1[1], 0, 150), end], { seed: 13 });
    // the detour is 150 m off for ~half of the points: mean ≈ 75 m > tolerance (50 m)
    expect(compareSignatures(direct, detour)).toMatchObject({ match: false, reason: 'shape' });
  });

  it('absorbs a small detour on an otherwise identical course', () => {
    const a = sigOf(LOOP, { seed: 14 });
    // the same loop with one corner cut: a 100 m shorter path through the middle of one side
    const cut = [...LOOP.slice(0, 20), ...LOOP.slice(26)];
    const b = sigOf(cut, { seed: 15 });
    const r = compareSignatures(a, b);
    expect(r.match).toBe(true);
  });
});

describe('routeKind', () => {
  it('classifies loops, out-and-backs and point-to-point routes', () => {
    expect(routeKind(sigOf(LOOP, { seed: 1 }))).toBe('loop');
    const there = line(VIENNA, 3000);
    expect(routeKind(sigOf([...there, ...[...there].reverse().slice(1)], { noiseM: 4, seed: 2 }))).toBe('out_and_back');
    expect(routeKind(sigOf(line(VIENNA, 6000), { seed: 3 }))).toBe('point_to_point');
  });
});

describe('assignRoutes', () => {
  const w = (id: number, sport: string, points: LatLon[], seed: number) => ({
    id,
    sport,
    sig: sigOf(points, { noiseM: 4, seed }),
  });
  const otherLoop = circle(OTHER_CENTER, 800, 72);

  it('groups workouts by course, direction and sport', () => {
    const list = [
      w(1, 'run', LOOP, 1),
      w(2, 'run', LOOP, 2),
      w(3, 'run', LOOP_REVERSED, 3), // other direction → its own route
      w(4, 'run', otherLoop, 4), // other place
      w(5, 'ride', LOOP, 5), // other sport
      w(6, 'run', LOOP, 6),
      w(7, 'run', LOOP_REVERSED, 7),
    ];
    const { assignment, founders } = assignRoutes([], list);
    const r = (id: number) => assignment.get(id)!;
    expect(r(1)).toBe(r(2));
    expect(r(2)).toBe(r(6));
    expect(r(3)).toBe(r(7));
    expect(new Set([r(1), r(3), r(4), r(5)]).size).toBe(4);
    expect([...assignment.values()].every((v) => v < 0)).toBe(true);
    // the first workout of every route is its founder
    expect(new Set(founders.values())).toEqual(new Set([1, 3, 4, 5]));
  });

  it('joins existing routes (incremental) before founding new ones', () => {
    const existing = [{ id: 42, sport: 'run', sig: sigOf(LOOP, { seed: 1 }) }];
    const { assignment, founders } = assignRoutes(existing, [w(10, 'run', LOOP, 11), w(11, 'run', otherLoop, 12), w(12, 'run', otherLoop, 13)]);
    expect(assignment.get(10)).toBe(42);
    expect(assignment.get(11)).toBe(assignment.get(12));
    expect(assignment.get(11)!).toBeLessThan(0);
    expect(founders.size).toBe(1);
  });

  it('prefers the better of two matching routes', () => {
    const near = { id: 1, sport: 'run', sig: sigOf(LOOP, { noiseM: 20, seed: 20 }) };
    const exact = { id: 2, sport: 'run', sig: sigOf(LOOP, { seed: 21 }) };
    const { assignment } = assignRoutes([near, exact], [w(5, 'run', LOOP, 22)]);
    expect(assignment.get(5)).toBe(2);
  });
});

describe('matchOldRoutes', () => {
  it('lets clusters take over the old route they overlap with most', () => {
    const next = new Map([
      [1, -1],
      [2, -1],
      [3, -1],
      [4, -2],
      [5, -2],
      [6, -3],
    ]);
    const old = new Map<number, number | null>([
      [1, 10],
      [2, 10],
      [3, 11],
      [4, 11],
      [5, 11],
      [6, null],
    ]);
    const m = matchOldRoutes(next, old);
    expect(m.get(-1)).toBe(10);
    expect(m.get(-2)).toBe(11); // the old route is claimed only once; -1 took 10, -2 takes 11
    expect(m.has(-3)).toBe(false);
    // a predicate can veto a reuse (other sport)
    const vetoed = matchOldRoutes(next, old, (n, o) => !(n === -1 && o === 10));
    expect(vetoed.get(-1)).toBe(11);
  });
});

describe('areaFromTimezone', () => {
  it('uses the city of the IANA zone', () => {
    expect(areaFromTimezone('Europe/Vienna')).toBe('Vienna');
    expect(areaFromTimezone('America/New_York')).toBe('New York');
    expect(areaFromTimezone('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(areaFromTimezone('Etc/GMT+1')).toBeNull();
    expect(areaFromTimezone(null)).toBeNull();
  });
});

describe('routes derive step + API', () => {
  let ctx: TestApp;
  const ids: Record<string, number> = {};
  const day = 86_400;
  const t0 = Date.UTC(2026, 2, 2, 7) / 1000;

  const addRun = (key: string, points: LatLon[], n: number, over: Parameters<typeof insertWorkout>[1] = {}) => {
    const tr = trackAlong(points, { speed: 3 + n * 0.02, noiseM: 4, seed: n * 7 + 1 });
    ids[key] = insertWorkout(ctx.db, { sport: 'run', startTs: t0 + n * 3 * day, track: tr, ...over });
    return ids[key]!;
  };

  const get = async <T>(url: string) => {
    const res = await ctx.app.inject({ url });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<T>();
  };
  const routes = async (min = 2) => (await get<MapsRoutesResponse>(`/api/maps/routes?min=${min}`)).items;

  beforeAll(async () => {
    ctx = await makeApp();
    // five laps of the loop (clockwise), two counter-clockwise, one other loop, one hidden lap, one ride
    for (let i = 0; i < 5; i++) addRun(`lap${i}`, LOOP, i);
    addRun('rev0', LOOP_REVERSED, 5);
    addRun('rev1', LOOP_REVERSED, 6);
    addRun('other', circle(OTHER_CENTER, 800, 72), 7);
    addRun('hidden', LOOP, 8, { hidden: true });
    ids.ride = insertWorkout(ctx.db, { sport: 'ride', startTs: t0 + 40 * day, track: trackAlong(LOOP, { speed: 7, noiseM: 4, seed: 99 }) });
    ids.strength = insertWorkout(ctx.db, { sport: 'strength', startTs: t0 + 50 * day });
    await runMapsSteps(ctx.db, 'all');
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('clusters the laps into routes and ignores workouts without a route', async () => {
    const all = await routes(1);
    expect(all.length).toBe(4); // clockwise loop, counter-clockwise loop, other place, ride
    const loop = all.find((r) => r.count === 5)!;
    expect(loop).toBeTruthy();
    expect(loop.sport).toBe('run');
    expect(loop.kind).toBe('loop');
    expect(loop.area).toBe('Vienna');
    expect(loop.distanceM).toBeGreaterThan(4800);
    expect(loop.distanceM).toBeLessThan(5400);
    expect(loop.customName).toBeNull();
    expect(loop.polyline!.length).toBeGreaterThan(10);
    const repeated = await routes(2);
    expect(repeated.map((r) => r.count).sort()).toEqual([2, 5]);
    // every GPS workout has a shape row, the strength workout has none
    const n = ctx.db.prepare('SELECT COUNT(*) AS n, COUNT(route_id) AS r FROM maps_workout_geo').get() as { n: number; r: number };
    expect(n).toEqual({ n: 10, r: 10 });
  });

  it('computes best / latest / first times and the speed trend', async () => {
    const loop = (await routes(2)).find((r) => r.count === 5)!;
    const detail = await get<MapsRouteDetail>(`/api/maps/routes/${loop.id}`);
    expect(detail.efforts.length).toBe(5);
    // newest first; the speed grows with the lap number → the newest effort is the fastest
    expect(detail.efforts[0]!.workoutId).toBe(ids.lap4);
    expect(detail.efforts[0]!.rank).toBe(1);
    expect(detail.efforts[4]!.workoutId).toBe(ids.lap0);
    expect(detail.efforts[4]!.rank).toBe(5);
    expect(loop.bestWorkoutId).toBe(ids.lap4);
    expect(loop.latestWorkoutId).toBe(ids.lap4);
    expect(loop.bestTimeS).toBeLessThan(loop.firstTimeS);
    expect(loop.trend.length).toBe(5);
    expect(loop.trend[4]!).toBeGreaterThan(loop.trend[0]!);
    expect(detail.efforts[0]!.avgSpeed!).toBeGreaterThan(3);
    expect(detail.efforts[0]!.avgHr).toBe(145);
    expect(detail.tracks.length).toBe(5);
    // the hidden lap is not an effort
    expect(detail.efforts.some((e) => e.workoutId === ids.hidden)).toBe(false);
  });

  it('renames a route and keeps the name across a full rebuild', async () => {
    const loop = (await routes(2)).find((r) => r.count === 5)!;
    const res = await ctx.app.inject({ method: 'PATCH', url: `/api/maps/routes/${loop.id}`, payload: { name: '  Prater Runde ' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<MapsRouteSummary>().customName).toBe('Prater Runde');
    await runMapsSteps(ctx.db, 'all');
    const again = (await routes(2)).find((r) => r.count === 5)!;
    expect(again.id).toBe(loop.id);
    expect(again.customName).toBe('Prater Runde');
    // an empty name resets to the generated one
    const reset = await ctx.app.inject({ method: 'PATCH', url: `/api/maps/routes/${loop.id}`, payload: { name: '' } });
    expect(reset.json<MapsRouteSummary>().customName).toBeNull();
    expect((await ctx.app.inject({ method: 'PATCH', url: '/api/maps/routes/9999', payload: { name: 'x' } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ url: '/api/maps/routes/9999' })).statusCode).toBe(404);
  });

  it('adds new workouts to the existing route incrementally', async () => {
    const before = (await routes(2)).find((r) => r.count === 5)!;
    const id = addRun('lap5', LOOP, 10);
    await runMapsSteps(ctx.db, [id]);
    const after = (await routes(2)).find((r) => r.id === before.id)!;
    expect(after.count).toBe(6);
    expect(after.latestWorkoutId).toBe(id);
    expect(after.lastTs).toBeGreaterThan(before.lastTs);
    // a workout elsewhere founds a new route (still a single effort)
    const far = addRun('far', circle(destination(VIENNA[0], VIENNA[1], 180, 20_000), 800, 72), 11);
    await runMapsSteps(ctx.db, [far]);
    expect((await routes(1)).length).toBe(5);
    expect((await routes(2)).length).toBe(2);
  });

  it('follows hide and sport changes', async () => {
    const loop = (await routes(2)).find((r) => r.count === 6)!;
    ctx.db.prepare('UPDATE workouts SET hidden = 1 WHERE id = ?').run(ids.lap1);
    expect((await routes(2)).find((r) => r.id === loop.id)!.count).toBe(5);
    ctx.db.prepare('UPDATE workouts SET hidden = 0 WHERE id = ?').run(ids.lap1);
    // a lap that becomes a "walk" leaves the run route and founds / joins a walk route
    ctx.db.prepare("UPDATE workouts SET sport = 'walk' WHERE id = ?").run(ids.lap2);
    await runMapsSteps(ctx.db, [ids.lap2]);
    const runLoop = (await routes(1)).find((r) => r.id === loop.id)!;
    expect(runLoop.count).toBe(5);
    const walk = (await routes(1)).find((r) => r.sport === 'walk')!;
    expect(walk.count).toBe(1);
    expect(walk.id).not.toBe(loop.id);
    // changing back merges it again
    ctx.db.prepare("UPDATE workouts SET sport = 'run' WHERE id = ?").run(ids.lap2);
    await runMapsSteps(ctx.db, [ids.lap2]);
    expect((await routes(1)).find((r) => r.id === loop.id)!.count).toBe(6);
    expect((await routes(1)).some((r) => r.sport === 'walk')).toBe(false);
  });

  it('filters by sport and reports the sport facets', async () => {
    const r = await get<MapsRoutesResponse>('/api/maps/routes?min=1&sport=ride');
    expect(r.items.map((x) => x.sport)).toEqual(['ride']);
    expect(r.sports.map((s) => s.sport).sort()).toEqual(['ride', 'run']);
    expect((await ctx.app.inject({ url: '/api/maps/routes?min=0' })).statusCode).toBe(400);
  });
});
