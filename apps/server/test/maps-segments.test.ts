import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  MapsSegmentDetail,
  MapsSegmentSource,
  MapsSegmentsResponse,
  MapsWorkoutLinks,
} from '@cadence/shared';
import { destination, type LatLon } from '../src/lib/geo';
import { VIENNA, insertWorkout, makeApp, runMapsSteps, trackAlong, type TestApp } from './maps-fixtures';

const east = destination(VIENNA[0], VIENNA[1], 90, 3000);
const north = destination(east[0], east[1], 0, 2000);
const ROAD: LatLon[] = [VIENNA, east, north];
/** Climbs 40 m over the first 2 km, flat afterwards. */
const ELE = (d: number) => 200 + Math.min(d, 2000) * 0.02;

describe('segments: creation, matching, ranking and the workout links', () => {
  let ctx: TestApp;
  const ids: Record<string, number> = {};
  const day = 86_400;
  const t0 = Date.UTC(2026, 3, 1, 7) / 1000;

  const run = (
    key: string,
    n: number,
    speed: number,
    points: LatLon[] = ROAD,
    over: Parameters<typeof insertWorkout>[1] = {},
    noiseM = 3,
  ) => {
    ids[key] = insertWorkout(ctx.db, {
      sport: 'run',
      startTs: t0 + n * 2 * day,
      track: trackAlong(points, { speed, noiseM, seed: n * 13 + 5, ele: ELE }),
      ...over,
    });
    return ids[key]!;
  };

  const api = async <T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, expected = 200) => {
    const res = await ctx.app.inject({ method, url, payload: payload as never });
    expect(res.statusCode, `${method} ${url}: ${res.body.slice(0, 300)}`).toBe(expected);
    return (res.body ? res.json() : undefined) as T;
  };

  let segmentId = 0;

  beforeAll(async () => {
    ctx = await makeApp();
    run('source', 0, 3.0, ROAD, {}, 0); // noise-free: its distances are the true ones, so segment = 3000 m exactly
    run('slow', 1, 2.5);
    run('fast', 2, 3.6);
    run('hidden', 3, 3.2, ROAD, { hidden: true });
    run('parallel', 4, 3, ROAD.map((p) => destination(p[0], p[1], 0, 90) as LatLon));
    run('abroad', 5, 3, ROAD.map((p) => [p[0] - 8, p[1] + 20] as LatLon));
    ids.walk = insertWorkout(ctx.db, { sport: 'walk', startTs: t0 + 12 * day, track: trackAlong(ROAD, { speed: 1.4, ele: ELE }) });
    ids.ride = insertWorkout(ctx.db, { sport: 'ride', startTs: t0 + 14 * day, track: trackAlong(ROAD, { speed: 8, ele: ELE }) });
    ids.strength = insertWorkout(ctx.db, { sport: 'strength', startTs: t0 + 16 * day });
    await runMapsSteps(ctx.db, 'all');
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('creates a segment from a stretch of a workout and matches the other workouts', async () => {
    const d = await api<MapsSegmentDetail>(
      'POST',
      '/api/maps/segments',
      { workoutId: ids.source, startM: 1000, endM: 4000, name: '  Corner climb ' },
      201,
    );
    segmentId = d.segment.id;
    expect(d.segment.name).toBe('Corner climb');
    expect(d.segment.sport).toBe('run');
    expect(d.segment.distanceM).toBeCloseTo(3000, 0);
    expect(d.segment.sourceWorkoutId).toBe(ids.source);
    // the first 1 km of the segment climbs 20 m, the rest is flat → ≈ 20 m gain, ≈ 0.7 % average grade
    expect(d.segment.elevationGainM!).toBeGreaterThan(17);
    expect(d.segment.elevationGainM!).toBeLessThan(23);
    expect(d.segment.avgGradePct!).toBeGreaterThan(0.5);
    expect(d.segment.avgGradePct!).toBeLessThan(0.9);
    expect(d.segment.polyline.length).toBeGreaterThan(10);
    // profile: ≤ 301 points from 0 to the segment length
    expect(d.profile.dist[0]).toBe(0);
    expect(d.profile.dist[d.profile.dist.length - 1]).toBeCloseTo(3000, 0);
    expect(d.profile.ele.every((e) => e !== null)).toBe(true);
    expect(d.profile.dist.length).toBeLessThanOrEqual(301);
    // source, slow and fast run (the hidden one is not visible, parallel / abroad / walk / ride do not match)
    expect(d.efforts.map((e) => e.workoutId).sort()).toEqual([ids.source, ids.slow, ids.fast].sort());
    const byWorkout = new Map(d.efforts.map((e) => [e.workoutId, e]));
    expect(byWorkout.get(ids.fast)!.rank).toBe(1);
    expect(byWorkout.get(ids.source)!.rank).toBe(2);
    expect(byWorkout.get(ids.slow)!.rank).toBe(3);
    expect(byWorkout.get(ids.fast)!.elapsedS).toBeCloseTo(3000 / 3.6, -1);
    expect(byWorkout.get(ids.slow)!.avgSpeed).toBeCloseTo(2.5, 0);
    expect(byWorkout.get(ids.source)!.avgHr).toBeGreaterThan(125);
    // newest first; PR flags follow chronology: source was the first → PR; slow was slower; fast beat the source
    expect(d.efforts.map((e) => e.workoutId)).toEqual([ids.fast, ids.slow, ids.source]);
    expect(d.efforts.map((e) => e.pr)).toEqual([true, false, true]);
    // the effort timestamp is the interpolated start-gate crossing (about 1000 m after the start)
    const src = byWorkout.get(ids.source)!;
    expect(src.startTs - (t0 + 0)).toBeGreaterThan(300);
    expect(src.startTs - (t0 + 0)).toBeLessThan(380);
  });

  it('keeps the hidden workout out of the statistics but stores its effort', async () => {
    const stored = ctx.db.prepare('SELECT COUNT(*) AS n FROM maps_segment_efforts WHERE workout_id = ?').get(ids.hidden) as { n: number };
    expect(stored.n).toBe(1);
    const list = await api<MapsSegmentsResponse>('GET', '/api/maps/segments');
    expect(list.items.length).toBe(1);
    expect(list.items[0]!).toMatchObject({ id: segmentId, efforts: 3, prWorkoutId: ids.fast });
    expect(list.items[0]!.prTimeS).toBeCloseTo(3000 / 3.6, -1);
    expect(list.items[0]!.lastTimeS).toBeCloseTo(3000 / 3.6, -1);
    // unhide → counts
    ctx.db.prepare('UPDATE workouts SET hidden = 0 WHERE id = ?').run(ids.hidden);
    const again = await api<MapsSegmentDetail>('GET', `/api/maps/segments/${segmentId}`);
    expect(again.efforts.length).toBe(4);
    ctx.db.prepare('UPDATE workouts SET hidden = 1 WHERE id = ?').run(ids.hidden);
  });

  it('matches new workouts through the derive step and is stable under a full rebuild', async () => {
    const id = run('newRun', 8, 3.3);
    await runMapsSteps(ctx.db, [id], ['maps.segments']);
    const d = await api<MapsSegmentDetail>('GET', `/api/maps/segments/${segmentId}`);
    expect(d.efforts.length).toBe(4);
    expect(d.efforts[0]!.workoutId).toBe(id);
    const snapshot = JSON.stringify(d.efforts.map((e) => [e.workoutId, e.idx, e.elapsedS, e.rank]));
    await runMapsSteps(ctx.db, 'all');
    const after = await api<MapsSegmentDetail>('GET', `/api/maps/segments/${segmentId}`);
    expect(JSON.stringify(after.efforts.map((e) => [e.workoutId, e.idx, e.elapsedS, e.rank]))).toBe(snapshot);
    // a workout that changes sport to a compatible/incompatible one is re-evaluated
    ctx.db.prepare("UPDATE workouts SET sport = 'walk' WHERE id = ?").run(id);
    await runMapsSteps(ctx.db, [id], ['maps.segments']);
    expect((await api<MapsSegmentDetail>('GET', `/api/maps/segments/${segmentId}`)).efforts.length).toBe(3);
    ctx.db.prepare("UPDATE workouts SET sport = 'run' WHERE id = ?").run(id);
    await runMapsSteps(ctx.db, [id], ['maps.segments']);
    expect((await api<MapsSegmentDetail>('GET', `/api/maps/segments/${segmentId}`)).efforts.length).toBe(4);
  });

  it('delivers the thinned route of a workout for the editor', async () => {
    const src = await api<MapsSegmentSource>('GET', `/api/maps/segments/source/${ids.source}`);
    expect(src.workoutId).toBe(ids.source);
    expect(src.totalM).toBeCloseTo(5000, -1);
    const n = src.points.dist.length;
    expect(n).toBeGreaterThan(100);
    expect(n).toBeLessThanOrEqual(1200);
    for (const k of ['lat', 'lon', 'ele', 't'] as const) expect(src.points[k].length).toBe(n);
    expect(src.points.dist[0]).toBe(0);
    expect(src.points.dist[n - 1]).toBeCloseTo(src.totalM, 0);
    expect(src.existing).toEqual([{ id: segmentId, name: 'Corner climb' }]);
    expect((await ctx.app.inject({ url: `/api/maps/segments/source/${ids.strength}` })).statusCode).toBe(400);
    expect((await ctx.app.inject({ url: '/api/maps/segments/source/99999' })).statusCode).toBe(404);
  });

  it('lists what the maps feature knows about a workout (segments + route)', async () => {
    const links = await api<MapsWorkoutLinks>('GET', `/api/maps/workouts/${ids.fast}`);
    expect(links.segments.length).toBe(1);
    expect(links.segments[0]!).toMatchObject({ segmentId, name: 'Corner climb', rank: 1, pr: true, efforts: 4, idx: 0 });
    expect(links.segments[0]!.elapsedS).toBeCloseTo(3000 / 3.6, -1);
    expect(links.route).not.toBeNull();
    expect(links.route!.count).toBeGreaterThanOrEqual(1);
    expect(links.route!.rank).toBe(1);
    const none = await api<MapsWorkoutLinks>('GET', `/api/maps/workouts/${ids.strength}`);
    expect(none).toEqual({ route: null, segments: [] });
    expect((await ctx.app.inject({ url: '/api/maps/workouts/99999' })).statusCode).toBe(404);
  });

  it('stars, renames and sorts starred segments first', async () => {
    const second = await api<MapsSegmentDetail>('POST', '/api/maps/segments', { workoutId: ids.source, startM: 100, endM: 700, name: 'Opener' }, 201);
    expect(second.efforts.length).toBeGreaterThanOrEqual(3);
    let list = await api<MapsSegmentsResponse>('GET', '/api/maps/segments');
    expect(list.items.map((s) => s.name)).toEqual(['Corner climb', 'Opener']); // newest effort first, then newest segment
    const starred = await api<MapsSegmentDetail>('PATCH', `/api/maps/segments/${second.segment.id}`, { starred: true });
    expect(starred.segment.starred).toBe(true);
    list = await api<MapsSegmentsResponse>('GET', '/api/maps/segments');
    expect(list.items[0]!.name).toBe('Opener');
    const renamed = await api<MapsSegmentDetail>('PATCH', `/api/maps/segments/${second.segment.id}`, { name: ' Warm-up ' });
    expect(renamed.segment.name).toBe('Warm-up');
    expect((await ctx.app.inject({ method: 'PATCH', url: `/api/maps/segments/${second.segment.id}`, payload: { name: '' } })).statusCode).toBe(400);
    await api('DELETE', `/api/maps/segments/${second.segment.id}`, undefined, 204);
    expect((await ctx.app.inject({ url: `/api/maps/segments/${second.segment.id}` })).statusCode).toBe(404);
    const left = ctx.db.prepare('SELECT COUNT(*) AS n FROM maps_segment_efforts WHERE segment_id = ?').get(second.segment.id) as { n: number };
    expect(left.n).toBe(0); // efforts go with the segment
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/maps/segments/${second.segment.id}` })).statusCode).toBe(404);
  });

  it('validates the creation request', async () => {
    const post = (payload: unknown) => ctx.app.inject({ method: 'POST', url: '/api/maps/segments', payload: payload as never });
    expect((await post({ workoutId: ids.source, startM: 500, endM: 400, name: 'x' })).statusCode).toBe(400);
    expect((await post({ workoutId: ids.source, startM: 500, endM: 560, name: 'x' })).statusCode).toBe(400); // < 100 m
    expect((await post({ workoutId: ids.source, startM: 0, endM: 1000, name: '   ' })).statusCode).toBe(400);
    expect((await post({ workoutId: 99999, startM: 0, endM: 1000, name: 'x' })).statusCode).toBe(404);
    expect((await post({ workoutId: ids.strength, startM: 0, endM: 1000, name: 'x' })).statusCode).toBe(400);
    expect((await post({ workoutId: ids.source, startM: -5, endM: 900, name: 'x' })).statusCode).toBe(400);
    // an end beyond the route is clamped to its end
    const all = await post({ workoutId: ids.source, startM: 0, endM: 99_999, name: 'Everything' });
    expect(all.statusCode).toBe(201);
    expect(all.json<MapsSegmentDetail>().segment.distanceM).toBeCloseTo(5000, -1);
  });
});
