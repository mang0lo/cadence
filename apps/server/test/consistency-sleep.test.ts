import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DayDetail, YearReview } from '@cadence/shared';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb, run, type Db } from '../src/db/db';
import { recomputeDailyMetrics, refreshTypeStats } from '../src/derive/daily';
import { rebuildSleepNights } from '../src/features/health/sleep';

/**
 * Sleep in the day popover and the year in review comes from the sleep nights of the health feature (the whole night
 * on its wake-up day, one source per night, COROS nights included), not from adding up daily_metrics per stage.
 */
let dir: string;
let db: Db;
let app: FastifyInstance;
const SLEEP_ID = 1;

let hash = 1;
function sleep(source: number, from: string, to: string, text: string) {
  run(
    db,
    `INSERT INTO records (athlete_id, type_id, start_ts, hash, end_ts, tz_min, text, source_id) VALUES (1, ?, ?, ?, ?, 120, ?, ?)`,
    [SLEEP_ID, Date.parse(from) / 1000, hash++, Date.parse(to) / 1000, text, source],
  );
}

async function getJson<T>(url: string): Promise<T> {
  const res = await app.inject({ url });
  expect(res.statusCode, `${url}: ${res.body.slice(0, 300)}`).toBe(200);
  return res.json<T>();
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-consistency-sleep-'));
  const config = loadConfig({ CADENCE_DATA_DIR: path.join(dir, 'data'), CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
  db = openDb(config.dbPath);
  migrateAll(db);
  run(db, "INSERT INTO sources (id, name) VALUES (1, 'Apple Watch'), (2, 'AutoSleep')");
  run(db, `INSERT INTO record_types (id, identifier, kind, unit, aggregation) VALUES (?, 'HKCategoryTypeIdentifierSleepAnalysis', 'category', NULL, 'duration')`, [
    SLEEP_ID,
  ]);
  // the night 9 → 10 June (+02:00): 8 h of stages from the watch, starting before midnight …
  sleep(1, '2026-06-09T22:30:00+02:00', '2026-06-09T23:30:00+02:00', 'AsleepCore');
  sleep(1, '2026-06-09T23:30:00+02:00', '2026-06-10T01:00:00+02:00', 'AsleepDeep');
  sleep(1, '2026-06-10T01:00:00+02:00', '2026-06-10T05:00:00+02:00', 'AsleepCore');
  sleep(1, '2026-06-10T05:00:00+02:00', '2026-06-10T06:30:00+02:00', 'AsleepREM');
  // … and the same night as one generic block from a second app
  sleep(2, '2026-06-09T22:30:00+02:00', '2026-06-10T06:30:00+02:00', 'AsleepUnspecified');
  // a COROS night (totals only) on the 12th; the COROS app's rings reach the 14th
  run(
    db,
    `INSERT INTO health_external_nights (athlete_id, source, day, asleep_s, deep_s, light_s, rem_s, awake_s)
     VALUES (1, 'COROS', '2026-06-12', 25200, 3600, 18000, 3600, 600)`,
  );
  run(db, "INSERT INTO activity_summaries (athlete_id, day, active_energy_kcal, exercise_min) VALUES (1, '2026-06-14', 400, 30)");
  // what the derive steps write: daily metrics per stage and the sleep nights
  recomputeDailyMetrics(db, 1, { id: SLEEP_ID, identifier: 'HKCategoryTypeIdentifierSleepAnalysis', kind: 'category', aggregation: 'duration' }, null);
  refreshTypeStats(db, 1, SLEEP_ID);
  rebuildSleepNights(db, 1, null);
  app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('consistency: sleep of a day and of a year', () => {
  it('shows the night that ended on the day once, also when two apps recorded it', async () => {
    expect((await getJson<DayDetail>('/api/consistency/day/2026-06-10')).health.sleepMin).toBe(480);
    // the hour before midnight belongs to the night of the 10th, not to the 9th
    expect((await getJson<DayDetail>('/api/consistency/day/2026-06-09')).health.sleepMin).toBeNull();
    // nights of the watch's cloud
    expect((await getJson<DayDetail>('/api/consistency/day/2026-06-12')).health.sleepMin).toBe(420);
  });

  it('averages the nights of the year', async () => {
    const y = await getJson<YearReview>('/api/consistency/year/2026?today=2026-06-15');
    expect(y.health.sleepPerNightMin.value).toBe(450);
    expect(y.health.sleepPerNightMin.prev).toBeNull();
  });
});
