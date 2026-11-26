import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImportHighlight } from '@cadence/shared';
import { mapsWhatsNew } from '../src/features/maps/whats-new';
import { destination, type LatLon } from '../src/lib/geo';
import { VIENNA, circle, insertWorkout, makeApp, runMapsSteps, trackAlong, type TestApp } from './maps-fixtures';

const DAY = 86_400;
const T0 = Date.UTC(2026, 7, 1, 7) / 1000;
const LOOP: LatLon[] = circle(destination(VIENNA[0], VIENNA[1], 45, 6000), 600, 60);
const OTHER_LOOP: LatLon[] = circle(destination(VIENNA[0], VIENNA[1], 225, 6000), 600, 60);

/** "New recurring route": the route shows up on the Routes page (2 activities) with this import. */
describe("what's new: recurring routes", () => {
  let ctx: TestApp;
  let n = 0;
  const addRun = (speed: number, loop = LOOP) =>
    insertWorkout(ctx.db, {
      sport: 'run',
      startTs: T0 + ++n * DAY,
      track: trackAlong(loop, { speed, noiseM: 3, seed: n * 5 }),
    });
  const routeHighlights = async (ids: number[]) => {
    await runMapsSteps(ctx.db, ids);
    return mapsWhatsNew({ db: ctx.db, athleteId: 1, workoutIds: ids, since: T0, initial: false }).filter(
      (h): h is ImportHighlight => h.kind === 'newRoute' || h.kind === 'routeBest',
    );
  };

  beforeAll(async () => {
    ctx = await makeApp();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('reports a route that becomes recurring with a later import', async () => {
    const first = addRun(3);
    expect(await routeHighlights([first])).toEqual([]); // done once: no route yet
    const second = addRun(2.8); // slower: no best time either
    const [h, ...rest] = await routeHighlights([second]);
    expect(rest).toEqual([]);
    expect(h).toMatchObject({ feature: 'maps', kind: 'newRoute', workoutId: first, data: { efforts: 2 } });
  });

  it('also reports the best time when the second activity is the faster one', async () => {
    const first = addRun(3, OTHER_LOOP);
    expect(await routeHighlights([first])).toEqual([]);
    const second = addRun(3.3, OTHER_LOOP);
    const h = await routeHighlights([second]);
    expect(h.map((x) => [x.kind, x.workoutId])).toEqual([
      ['newRoute', second],
      ['routeBest', second],
    ]);
    expect(Number(h[1]!.data.timeS)).toBeLessThan(Number(h[1]!.data.previousS));
  });

  it('reports a best time once the route was recurring before', async () => {
    const third = addRun(3.4);
    const [h, ...rest] = await routeHighlights([third]);
    expect(rest).toEqual([]);
    expect(h).toMatchObject({ kind: 'routeBest', workoutId: third, data: { efforts: 3 } });
    expect(Number(h!.data.timeS)).toBeLessThan(Number(h!.data.previousS));
    // a slower run on a recurring route is no highlight
    expect(await routeHighlights([addRun(2.5)])).toEqual([]);
  });
});
