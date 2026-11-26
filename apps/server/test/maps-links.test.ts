import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MapsSegmentDetail, MapsWorkoutLinks } from '@cadence/shared';
import type { LatLon } from '../src/lib/geo';
import { VIENNA, circle, insertWorkout, makeApp, runMapsSteps, trackAlong, type TestApp } from './maps-fixtures';

/** GET /maps/workouts/:id – the route and segment efforts of one workout, ranked among the visible ones. */
describe('activity page links', () => {
  let ctx: TestApp;
  const day = 86_400;
  const t0 = Date.UTC(2026, 5, 1, 7) / 1000;
  const LOOP = circle(VIENNA, 600, 72);
  const TWICE: LatLon[] = [...LOOP, ...LOOP.slice(1)];
  const ids: Record<string, number> = {};
  const seg: Record<string, number> = {};

  const links = async (workoutId: number) => {
    const res = await ctx.app.inject({ url: `/api/maps/workouts/${workoutId}` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<MapsWorkoutLinks>();
  };
  const createSegment = async (startM: number, endM: number, name: string) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/maps/segments',
      payload: { workoutId: ids.source, startM, endM, name },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<MapsSegmentDetail>().segment.id;
  };

  beforeAll(async () => {
    ctx = await makeApp();
    const add = (key: string, n: number, speed: number, points: LatLon[], hidden = false) => {
      ids[key] = insertWorkout(ctx.db, {
        sport: 'run',
        startTs: t0 + n * day,
        hidden,
        track: trackAlong(points, { speed, noiseM: n ? 2 : 0, seed: n * 7 + 3 }),
      });
    };
    add('source', 0, 3.0, LOOP);
    add('slow', 1, 2.5, LOOP);
    add('double', 2, 3.3, TWICE);
    add('hidden', 3, 4.0, LOOP, true);
    await runMapsSteps(ctx.db, 'all');
    seg.zulu = await createSegment(200, 1400, 'Zulu');
    seg.alpha = await createSegment(1600, 2400, 'Alpha');
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('ranks every effort of a workout among the visible efforts of each segment', async () => {
    const l = await links(ids.double);
    const zulu = l.segments.filter((s) => s.segmentId === seg.zulu);
    // two laps: two efforts, the earlier one first; both faster than the single laps, the hidden run does not count
    expect(zulu.map((s) => s.idx)).toEqual([0, 1]);
    const fasterLap = zulu[0]!.elapsedS <= zulu[1]!.elapsedS ? 0 : 1;
    expect(zulu.map((s) => [s.rank, s.pr, s.efforts])).toEqual(
      fasterLap === 0
        ? [
            [1, true, 4],
            [2, false, 4],
          ]
        : [
            [2, false, 4],
            [1, true, 4],
          ],
    );
    for (const s of zulu) {
      expect(s.elapsedS).toBeCloseTo(1200 / 3.3, -1);
      expect(s.avgSpeed).toBeCloseTo(3.3, 0);
      expect(s.distanceM).toBeCloseTo(1200, -1);
      expect(s.name).toBe('Zulu');
      expect(s.starred).toBe(false);
    }
    // segments sorted by name (none starred), efforts of one segment chronological
    expect(l.segments.map((s) => s.name)).toEqual(['Alpha', 'Alpha', 'Zulu', 'Zulu']);

    const slow = await links(ids.slow);
    expect(slow.segments.map((s) => [s.name, s.rank, s.pr, s.efforts])).toEqual([
      ['Alpha', 4, false, 4],
      ['Zulu', 4, false, 4],
    ]);
  });

  it('puts starred segments first', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/maps/segments/${seg.zulu}`,
      payload: { starred: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    const l = await links(ids.source);
    expect(l.segments.map((s) => [s.name, s.starred, s.rank])).toEqual([
      ['Zulu', true, 3],
      ['Alpha', false, 3],
    ]);
  });

  it('ranks the workout on its route by time; a hidden workout has no rank and no efforts', async () => {
    const slow = await links(ids.slow);
    const source = await links(ids.source);
    expect(slow.route).not.toBeNull();
    expect(source.route!.id).toBe(slow.route!.id);
    expect(source.route!.count).toBe(2); // the hidden run is not counted
    expect(source.route!.rank).toBe(1);
    expect(slow.route!.rank).toBe(2);
    expect(slow.route!.bestTimeS).toBe(source.route!.bestTimeS);

    const hidden = await links(ids.hidden);
    expect(hidden.segments).toEqual([]);
    if (hidden.route) {
      expect(hidden.route.id).toBe(source.route!.id);
      expect(hidden.route.rank).toBeNull();
    }
  });
});
