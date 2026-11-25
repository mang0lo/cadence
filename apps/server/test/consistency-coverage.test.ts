import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Goal, GoalsResponse, HealthOverview, StreakSummary } from '@cadence/shared';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { dataHorizon, lastCompleteDay, resolveDays, sourceEnd } from '../src/core/coverage';
import { openDb, run, type Db } from '../src/db/db';
import { DERIVE_VERSION } from '../src/derive/context';
import { refreshDailyActivity } from '../src/derive/daily';
import { deleteCorosHealth, refreshCorosMetrics, storeCorosDays } from '../src/features/connect/coros-health';
import { addDays } from '../src/lib/time';

/**
 * "As of" for athletes whose data comes from a device cloud: COROS writes daily values (resting HR, load, fatigue …)
 * for every day the watch is worn, rest days included, so they show that the data covers the days after the last
 * workout. Runs every day 8–22 June 2026 (Monday 22nd), nothing on 23 and 24 June.
 */
let dir: string;
let db: Db;
let app: FastifyInstance;
const TODAY = '2026-06-24'; // a Wednesday

let ext = 0;
function addRun(day: string) {
  const start = Date.parse(`${day}T07:00:00+02:00`) / 1000;
  run(
    db,
    `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, distance_m, derived_version)
     VALUES (1, ?, 'HKWorkoutActivityTypeRunning', 'run', ?, ?, 120, 1800, 6000, ?)`,
    [`fit:1:${ext++}`, start, start + 1800, DERIVE_VERSION],
  );
}

/** COROS Training Hub values of one day (as analyse/dayDetail/query returns them). */
const corosDay = (day: string) => ({ happenDay: Number(day.replace(/-/g, '')), rhr: 48, ati: 40, cti: 52, tiredRate: 30 });

async function getJson<T>(url: string): Promise<T> {
  const res = await app.inject({ url });
  expect(res.statusCode, `${url}: ${res.body.slice(0, 300)}`).toBe(200);
  return res.json<T>();
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-coverage-'));
  const config = loadConfig({ CADENCE_DATA_DIR: path.join(dir, 'data'), CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
  db = openDb(config.dbPath);
  migrateAll(db);
  for (let d = '2026-06-08'; d <= '2026-06-22'; d = addDays(d, 1)) addRun(d);
  refreshDailyActivity(db, 1);
  app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('data coverage (core/coverage.ts)', () => {
  it('ends at the last workout when nothing else shows coverage (FIT files only)', () => {
    expect(dataHorizon(db, 1)).toBe('2026-06-22');
    expect(resolveDays(db, 1, TODAY)).toEqual({ today: TODAY, asOf: '2026-06-22' });
  });

  it('follows the daily values of a device cloud past the last workout', async () => {
    const days = [];
    for (let d = '2026-06-01'; d <= TODAY; d = addDays(d, 1)) days.push(corosDay(d));
    storeCorosDays(db, 1, days);
    refreshCorosMetrics(db, 1, null);
    expect(dataHorizon(db, 1)).toBe(TODAY);

    // the streak ended on Monday: Tuesday had no activity although the watch was worn
    const s = await getJson<StreakSummary>(`/api/consistency/streaks?today=${TODAY}`);
    expect(s.asOf).toBe(TODAY);
    expect(s.daily).toMatchObject({ current: 0, longest: 15, pending: false });
    expect(s.recent[13]).toEqual({ day: TODAY, active: false });

    // goals: the current week is the real one, and Tuesday counts as missed instead of pending
    const seeded = await getJson<GoalsResponse>(`/api/consistency/goals?today=${TODAY}`);
    expect(seeded.asOf).toBe(TODAY);
    const week = seeded.goals.find((x) => x.period === 'week')!;
    expect(week.current).toMatchObject({ start: '2026-06-22', end: '2026-06-28', value: 1 });
    const res = await app.inject({
      method: 'POST',
      url: '/api/consistency/goals',
      payload: { period: 'day', sport: 'run', metric: 'distance', target: 5000 },
    });
    const daily = res.json<Goal>();
    const g = await getJson<GoalsResponse>(`/api/consistency/goals?today=${TODAY}`);
    const tuesday = g.goals.find((x) => x.id === daily.id)!.history.find((h) => h.start === '2026-06-23')!;
    expect(tuesday).toEqual({ start: '2026-06-23', end: '2026-06-23', value: 0, hit: false });

    // the health pages judge the same day
    expect((await getJson<HealthOverview>('/api/health/overview')).asOf).toBe(TODAY);
  });

  it('never moves asOf past the client today, and falls back when the device data is removed', () => {
    expect(resolveDays(db, 1, '2026-06-23').asOf).toBe('2026-06-23');
    deleteCorosHealth(db, 1);
    expect(dataHorizon(db, 1)).toBe('2026-06-22');
  });

  it('counts the newest Apple Health export also when a later FIT or COROS import job has no export date', () => {
    const job = (id: string, finished: number, stats: string | null) =>
      run(db, `INSERT INTO import_jobs (id, athlete_id, kind, status, stats, finished_at) VALUES (?, 1, 'import', 'done', ?, ?)`, [
        id,
        stats,
        finished,
      ]);
    job('apple', 100, JSON.stringify({ exportDate: '2026-06-24 08:00:00 +0200' }));
    job('fit', 200, JSON.stringify({ exportDate: null }));
    job('none', 300, null);
    job('broken', 400, '{not json');
    expect(dataHorizon(db, 1)).toBe(TODAY);
    expect(sourceEnd(db, 1, 'apple')).toMatchObject({ day: TODAY, tzMin: 120 });
    run(db, 'DELETE FROM import_jobs');
  });

  it('knows whether the last day of a source is complete', () => {
    const at = (iso: string, tzMin: number) => ({ ts: Date.parse(iso) / 1000, tzMin, day: iso.slice(0, 10) });
    const now = Date.parse('2026-06-30T12:00:00Z') / 1000;
    // an export taken in the morning holds only that morning
    expect(lastCompleteDay(at('2026-06-24T08:00:00+02:00', 120), now)).toBe('2026-06-23');
    // data reaching into the last hour of a day: that day is complete
    expect(lastCompleteDay(at('2026-06-24T23:40:00+02:00', 120), now)).toBe('2026-06-24');
    // a sample in the future (wrong clock) counts as now
    expect(lastCompleteDay(at('2026-07-01T23:40:00+02:00', 120), now)).toBe('2026-06-29');
  });
});
