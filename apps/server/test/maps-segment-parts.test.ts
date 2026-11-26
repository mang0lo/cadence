import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MapsSegmentDetail } from '@cadence/shared';
import { run } from '../src/db/db';
import { destination, type LatLon } from '../src/lib/geo';
import { gzipJson } from '../src/lib/gzip';
import { matchSegment, sliceStream, thinPath, type MatchTrack } from '../src/features/maps/segment-match';
import { VIENNA, insertWorkout, makeApp, trackAlong, type TestApp, type TestTrack } from './maps-fixtures';

/** A point `x` meters east of VIENNA on a straight road. */
const along = (x: number): LatLon => destination(VIENNA[0], VIENNA[1], 90, x);
const road = trackAlong([VIENNA, along(2000)], { speed: 3 });
/** The segment from 300 m to 1500 m of the road (1.2 km). */
const SEG = thinPath(sliceStream({ lat: road.lat, lon: road.lon, dist: road.dist, ele: road.ele }, 300, 1500));

/** The road from `fromM` on, as a later part of a track: its cumulative distance goes on from `offsetM`. */
function laterPart(fromM: number, offsetM: number): MatchTrack {
  const tr = trackAlong([along(fromM), along(2000)], { speed: 3 });
  return { t: tr.t, lat: tr.lat, lon: tr.lon, dist: tr.dist.map((d) => d + offsetM) };
}

/**
 * A track in several parts (a workout paused, moved by train and continued): the distance of a later part goes on
 * where the previous part ended.
 */
describe('segments on later parts of a track', () => {
  it('matches a part that starts right at the start gate', () => {
    for (const offset of [0, 5000]) {
      const [m, ...rest] = matchSegment(SEG, laterPart(300, offset));
      expect(rest, `offset ${offset}`).toEqual([]);
      expect(m, `offset ${offset}`).toBeDefined();
      expect(m!.trackM).toBeCloseTo(1200, -1);
      expect(m!.elapsedS).toBeCloseTo(400, -1);
    }
  });

  it('matches a part that crosses the start gate between its first two fixes', () => {
    for (const offset of [0, 5000]) {
      const [m, ...rest] = matchSegment(SEG, laterPart(298.5, offset));
      expect(rest, `offset ${offset}`).toEqual([]);
      expect(m, `offset ${offset}`).toBeDefined();
      expect(m!.trackM).toBeCloseTo(1200, -1);
    }
  });

  describe('a workout paused and continued elsewhere', () => {
    let ctx: TestApp;
    let workoutId = 0;
    let partStartM = 0;

    beforeAll(async () => {
      ctx = await makeApp();
      // first part 20 km north of the road, then (after a train ride) the road
      const north = destination(VIENNA[0], VIENNA[1], 0, 20_000);
      const first = trackAlong([north, destination(north[0], north[1], 90, 2500)], { speed: 3 });
      const second = trackAlong([VIENNA, along(2000)], { speed: 3 });
      partStartM = first.dist[first.dist.length - 1]!;
      const tEnd = first.t[first.t.length - 1]!;
      const track: TestTrack = {
        t: [...first.t, ...second.t.map((t) => t + tEnd + 1800)],
        lat: [...first.lat, ...second.lat],
        lon: [...first.lon, ...second.lon],
        dist: [...first.dist, ...second.dist.map((d) => Math.round((d + partStartM) * 10) / 10)],
        ele: [...first.ele, ...second.ele],
        hr: [...first.hr, ...second.hr],
      };
      workoutId = insertWorkout(ctx.db, { sport: 'run', startTs: Date.UTC(2026, 5, 1, 7) / 1000, track });
      run(ctx.db, 'UPDATE workout_streams SET data = ? WHERE workout_id = ?', [
        gzipJson({ ...track, moving: track.t.map(() => 1), breaks: [first.t.length] }),
        workoutId,
      ]);
    }, 60_000);

    afterAll(async () => {
      await ctx?.close();
    });

    it('matches a segment drawn from the first point of the later part with its own workout', async () => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/maps/segments',
        payload: { workoutId, startM: partStartM, endM: partStartM + 1200, name: 'After the train' },
      });
      expect(res.statusCode, res.body).toBe(201);
      const detail = res.json<MapsSegmentDetail>();
      expect(detail.segment.distanceM).toBeCloseTo(1200, 0);
      expect(detail.efforts.map((e) => e.workoutId)).toEqual([workoutId]);
      expect(detail.efforts[0]!.elapsedS).toBeCloseTo(400, -1);
    });
  });
});
