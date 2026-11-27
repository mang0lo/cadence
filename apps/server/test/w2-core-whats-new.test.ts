import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImportHighlight } from '@cadence/shared';
import { get, run } from '../src/db/db';
import { features } from '../src/features';
import { mapsWhatsNew } from '../src/features/maps/whats-new';
import type { WhatsNewInput } from '../src/features/types';
import { importSummary } from '../src/import/summary';
import { destination, type LatLon } from '../src/lib/geo';
import { VIENNA, insertWorkout, makeApp, runMapsSteps, trackAlong, type TestApp } from './maps-fixtures';

const DAY = 86_400;
const T0 = Date.UTC(2026, 4, 1, 7) / 1000;
const road = (bearing: number, km: number): LatLon[] => {
  const start = destination(VIENNA[0], VIENNA[1], bearing, km * 1000);
  return [start, destination(start[0], start[1], 90, 3000)];
};
const kinds = (h: ImportHighlight[]) => h.map((x) => x.kind).sort();

let ctx: TestApp;

beforeAll(async () => {
  ctx = await makeApp();
});

afterAll(async () => {
  await ctx?.close();
});

describe("what's new of an import", () => {
  it('hands features every workout the import added, hidden ones and duplicates included', () => {
    const { db } = ctx;
    const visible = insertWorkout(db, { startTs: T0 });
    const hidden = insertWorkout(db, { startTs: T0 + DAY, hidden: true });
    const duplicate = insertWorkout(db, { startTs: T0, duplicateOf: visible });
    const seen: WhatsNewInput[] = [];
    const feature = { name: 'spy', whatsNew: (input: WhatsNewInput) => (seen.push(input), []) };
    features.push(feature);
    try {
      const summary = importSummary(db, 1, [visible, hidden, duplicate], T0);
      expect(summary.count).toBe(1);
    } finally {
      features.splice(features.indexOf(feature), 1);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.workoutIds).toEqual([visible]);
    expect(seen[0]!.importedIds).toEqual([visible, hidden, duplicate]);
    run(db, 'UPDATE workouts SET hidden = 1 WHERE id IN (?, ?)', [visible, duplicate]);
  });

  it('knows a replaced copy from the ids of the import, also without a running job (CLI import)', async () => {
    const { db } = ctx;
    expect(get(db, "SELECT 1 FROM import_jobs WHERE status = 'running'")).toBeUndefined();
    // a run from Apple Health with its route, imported earlier …
    const health = insertWorkout(db, { startTs: T0 + 2 * DAY, track: trackAlong(road(0, 5), { speed: 3, noiseM: 3, seed: 1 }) });
    await runMapsSteps(db, 'all');
    // … and an import with the watch's own file of it (preferred: the Health copy becomes its duplicate) plus a new run
    const watch = insertWorkout(db, { startTs: T0 + 2 * DAY, track: trackAlong(road(0, 5), { speed: 3, noiseM: 3, seed: 2 }) });
    run(db, 'UPDATE workouts SET duplicate_of = ? WHERE id = ?', [watch, health]);
    const fresh = insertWorkout(db, { startTs: T0 + 3 * DAY, track: trackAlong(road(180, 5), { speed: 3, noiseM: 3, seed: 3 }) });
    await runMapsSteps(db, [watch, fresh]);
    const input = { db, athleteId: 1, since: T0, initial: false };
    const both = mapsWhatsNew({ ...input, workoutIds: [watch, fresh], importedIds: [watch, fresh] });
    const onlyFresh = mapsWhatsNew({ ...input, workoutIds: [fresh], importedIds: [watch, fresh] });
    expect(kinds(both)).toEqual(['explorerTiles']);
    // the watch file brought no tiles: the run was on the maps before
    expect(both).toEqual(onlyFresh);
    expect(mapsWhatsNew({ ...input, workoutIds: [watch], importedIds: [watch] })).toEqual([]);
  });

  it('counts an activity as new when both of its copies came with the same import', async () => {
    const { db } = ctx;
    const health = insertWorkout(db, { startTs: T0 + 5 * DAY, track: trackAlong(road(90, 6), { speed: 3, noiseM: 3, seed: 4 }) });
    const watch = insertWorkout(db, { startTs: T0 + 5 * DAY, track: trackAlong(road(90, 6), { speed: 3, noiseM: 3, seed: 5 }) });
    run(db, 'UPDATE workouts SET duplicate_of = ? WHERE id = ?', [watch, health]);
    await runMapsSteps(db, [health, watch]);
    const h = mapsWhatsNew({ db, athleteId: 1, workoutIds: [watch], importedIds: [health, watch], since: T0, initial: false });
    expect(kinds(h)).toEqual(['explorerTiles']);
    expect(Number(h[0]!.data.count)).toBeGreaterThan(0);
  });
});
