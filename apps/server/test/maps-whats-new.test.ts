import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImportHighlight, MapsSegmentDetail } from '@cadence/shared';
import { run } from '../src/db/db';
import { mapsWhatsNew } from '../src/features/maps/whats-new';
import { destination, type LatLon } from '../src/lib/geo';
import { VIENNA, insertWorkout, makeApp, runMapsSteps, trackAlong, type TestApp } from './maps-fixtures';

const ROAD: LatLon[] = [VIENNA, destination(VIENNA[0], VIENNA[1], 90, 3000)];
/** A road 3 km north of the first one (other explorer tiles). */
const north = destination(VIENNA[0], VIENNA[1], 0, 3000);
const OTHER_ROAD: LatLon[] = [north, destination(north[0], north[1], 90, 3000)];
const DAY = 86_400;
const T0 = Date.UTC(2026, 3, 1, 7) / 1000;

const kinds = (h: ImportHighlight[]) => h.map((x) => x.kind).sort();

describe("what's new: an import that brings the preferred copy of activities the athlete already had", () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await makeApp();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('reports only what the really new activities brought', async () => {
    const { db } = ctx;
    // three runs on the road from Apple Health, imported a day ago: a recurring route with a segment on it
    const health = [0, 1, 2].map((n) =>
      insertWorkout(db, {
        sport: 'run',
        startTs: T0 + n * DAY,
        track: trackAlong(ROAD, { speed: 3 + n * 0.1, noiseM: 3, seed: n + 1 }),
      }),
    );
    run(db, 'UPDATE workouts SET created_at = created_at - 86400');
    await runMapsSteps(db, 'all');
    const seg = await ctx.app.inject({
      method: 'POST',
      url: '/api/maps/segments',
      payload: { workoutId: health[0], startM: 500, endM: 2500, name: 'Road' },
    });
    expect(seg.statusCode).toBe(201);
    expect(seg.json<MapsSegmentDetail>().efforts).toHaveLength(3);

    // the import starts: the watch's own files of the same three runs (preferred over the Health copies) …
    run(db, "INSERT INTO import_jobs (id, athlete_id, kind, status, started_at) VALUES ('job', 1, 'import', 'running', unixepoch())");
    const watch = [0, 1, 2].map((n) =>
      insertWorkout(db, {
        sport: 'run',
        startTs: T0 + n * DAY,
        track: trackAlong(ROAD, { speed: 3 + n * 0.1, noiseM: 3, seed: n + 11 }),
      }),
    );
    health.forEach((h, n) => run(db, 'UPDATE workouts SET duplicate_of = ? WHERE id = ?', [watch[n], h]));
    // … plus two activities that are really new: a faster run on the road and a run on another road
    const faster = insertWorkout(db, {
      sport: 'run',
      startTs: T0 + 5 * DAY,
      track: trackAlong(ROAD, { speed: 3.6, noiseM: 3, seed: 21 }),
    });
    const elsewhere = insertWorkout(db, {
      sport: 'run',
      startTs: T0 + 6 * DAY,
      track: trackAlong(OTHER_ROAD, { speed: 3, noiseM: 3, seed: 22 }),
    });
    const ids = [...watch, faster, elsewhere];
    await runMapsSteps(db, ids);

    // the replaced copies bring nothing: no "new recurring route", their efforts are not new
    const all = mapsWhatsNew({ db, athleteId: 1, workoutIds: ids, since: T0, initial: false });
    expect(kinds(all)).toEqual(['explorerTiles', 'routeBest', 'segmentEfforts', 'segmentPr']);
    expect(all.find((h) => h.kind === 'routeBest')!.workoutId).toBe(faster);
    expect(all.find((h) => h.kind === 'segmentPr')!.workoutId).toBe(faster);
    expect(all.find((h) => h.kind === 'segmentEfforts')!.data).toMatchObject({ count: 1, segments: 1 });
    // only the run on the other road visited tiles nobody visited before
    const onlyElsewhere = mapsWhatsNew({ db, athleteId: 1, workoutIds: [elsewhere], since: T0, initial: false });
    expect(all.find((h) => h.kind === 'explorerTiles')!.data).toEqual(
      onlyElsewhere.find((h) => h.kind === 'explorerTiles')!.data,
    );
    // an import of nothing but replacements has no highlights at all
    expect(mapsWhatsNew({ db, athleteId: 1, workoutIds: watch, since: T0, initial: false })).toEqual([]);
  });
});
