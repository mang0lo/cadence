import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProgressFtpResponse, ProgressRecordsResponse, WorkoutStreams } from '@cadence/shared';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb, run, type Db } from '../src/db/db';
import { DERIVE_VERSION } from '../src/derive/context';
import type { DeriveContext } from '../src/features/types';
import { workoutCachesStep } from '../src/features/progress/derive';
import { records } from '../src/features/progress/records';
import { gzipJson } from '../src/lib/gzip';
import { addDays, parseDay } from '../src/lib/time';

/**
 * Progress → Records counts attempts and finds highlights per period of the page (all time, this year, the last 12
 * months); the dashboard's power widget asks for the FTP estimate without its monthly history.
 */
const TODAY = '2026-11-03';
let dir: string;
let db: Db;
let app: FastifyInstance;

const getJson = async <T>(url: string): Promise<T> => {
  const res = await app.inject({ url });
  expect(res.statusCode, `${url}: ${res.body.slice(0, 300)}`).toBe(200);
  return res.json<T>();
};

let ext = 0;
/** A run at 08:00 local (UTC+1) on `day` with a 5K best effort of `fiveK` seconds. */
function runOn(day: string, o: { fiveK?: number; distanceM: number; elevationM?: number; tzMin?: number; hour?: number }) {
  const tzMin = o.tzMin ?? 60;
  const start = parseDay(day)! * 86400 + (o.hour ?? 8) * 3600 - tzMin * 60;
  const id = run(
    db,
    `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, name, start_ts, end_ts, tz_min, duration_s,
       distance_m, elevation_gain_m, avg_speed, derived_version)
     VALUES (1, ?, 'HKWorkoutActivityTypeRunning', 'run', ?, ?, ?, ?, 3600, ?, ?, ?, ?)`,
    [`r${ext++}`, day, start, start + 3600, tzMin, o.distanceM, o.elevationM ?? null, o.distanceM / 3600, DERIVE_VERSION],
  ).lastInsertRowid;
  if (o.fiveK)
    run(
      db,
      `INSERT INTO best_efforts (athlete_id, workout_id, sport, effort, distance_m, elapsed_s, start_offset_s, start_ts)
       VALUES (1, ?, 'run', '5k', 5000, ?, 0, ?)`,
      [id, o.fiveK, start],
    );
  return id;
}

/** A ride at noon (UTC+1) `daysAgo` days before TODAY with a power stream. */
function rideWithPower(daysAgo: number, watts: (t: number) => number, seconds: number) {
  const start = parseDay(addDays(TODAY, -daysAgo))! * 86400 + 11 * 3600;
  const t: number[] = [];
  const power: number[] = [];
  for (let s = 0; s <= seconds; s++) {
    t.push(s);
    power.push(watts(s));
  }
  const st: WorkoutStreams = { t, power, moving: t.map(() => 1) };
  const id = run(
    db,
    `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, avg_power,
       derived_version, updated_at)
     VALUES (1, ?, 'HKWorkoutActivityTypeCycling', 'ride', ?, ?, 60, ?, ?, ?, 1000)`,
    [`p${ext++}`, start, start + seconds, seconds, power.reduce((x, y) => x + y, 0) / power.length, DERIVE_VERSION],
  ).lastInsertRowid;
  run(db, 'INSERT INTO workout_streams (workout_id, version, points, data) VALUES (?, 1, ?, ?)', [id, t.length, gzipJson(st)]);
  return id;
}

const ctx = (): DeriveContext => ({
  db,
  athleteId: 1,
  workoutIds: 'all',
  sinceDay: null,
  report: () => {},
  checkCancelled: () => {},
  log: () => {},
});

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-w2-progress-'));
  const config = loadConfig({ CADENCE_DATA_DIR: path.join(dir, 'data'), CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
  db = openDb(config.dbPath);
  migrateAll(db);
  // all time: the fastest 5K and the longest run, two years ago
  runOn('2024-05-01', { fiveK: 1200, distanceM: 30000, elevationM: 900 });
  // last 12 months, but last year
  runOn('2025-12-01', { fiveK: 1300, distanceM: 21100, elevationM: 50 });
  runOn('2025-12-20', { fiveK: 1350, distanceM: 10000 });
  // this year
  runOn('2026-03-01', { fiveK: 1400, distanceM: 12000, elevationM: 300 });
  // 23:30 on Dec 31 at UTC−05:00 is already Jan 1 in UTC: it belongs to last year, also for the highlights
  runOn('2025-12-31', { fiveK: 1450, distanceM: 15000, tzMin: -300, hour: 23 });
  // a ride with power 10 days ago: 25 minutes at 250 W with 5 minutes at 320 W
  rideWithPower(10, (t) => (t >= 600 && t < 900 ? 320 : 250), 1500);
  await workoutCachesStep.run(ctx());
  app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('records per period', () => {
  it('counts the attempts of every period of the page', () => {
    const r = records(db, 1, { sport: 'run', today: TODAY });
    const fiveK = r.efforts.find((e) => e.effort === '5k')!;
    expect(fiveK.attempts).toBe(5);
    expect(fiveK.scopeAttempts).toEqual({ allTime: 5, thisYear: 1, last12m: 4 });
    expect(fiveK.thisYear?.elapsedS).toBe(1400);
    expect(fiveK.last12m?.elapsedS).toBe(1300);
    const tenK = r.efforts.find((e) => e.effort === '10k')!;
    expect(tenK.scopeAttempts).toEqual({ allTime: 0, thisYear: 0, last12m: 0 });
  });

  it('finds the highlights of every period', () => {
    const r = records(db, 1, { sport: 'run', today: TODAY });
    const value = (scope: keyof ProgressRecordsResponse['scopeHighlights'], key: string) =>
      r.scopeHighlights[scope].find((h) => h.key === key)?.value ?? null;
    expect(r.scopeHighlights.allTime).toEqual(r.highlights);
    expect(value('allTime', 'longest')).toBe(30000);
    expect(value('last12m', 'longest')).toBe(21100);
    expect(value('thisYear', 'longest')).toBe(12000);
    expect(value('allTime', 'climb')).toBe(900);
    expect(value('last12m', 'climb')).toBe(300);
    expect(value('thisYear', 'climb')).toBe(300);
    // the late New Year's Eve run is last year's in its own time zone
    expect(r.scopeHighlights.thisYear.every((h) => h.workout.name !== '2025-12-31')).toBe(true);
  });

  it('answers with the same shape over the API', async () => {
    const r = await getJson<ProgressRecordsResponse>(`/api/progress/records?sport=run&today=${TODAY}`);
    expect(Object.keys(r.scopeHighlights).sort()).toEqual(['allTime', 'last12m', 'thisYear']);
    expect(r.efforts.find((e) => e.effort === '5k')!.scopeAttempts.thisYear).toBe(1);
  });
});

describe('FTP estimate for the dashboard', () => {
  it('leaves out the monthly history with history=0 and names the bests of its window', async () => {
    const full = await getJson<ProgressFtpResponse>(`/api/progress/power/ftp?today=${TODAY}`);
    const lean = await getJson<ProgressFtpResponse>(`/api/progress/power/ftp?today=${TODAY}&history=0`);
    expect(full.history.points.length).toBeGreaterThan(0);
    expect(lean.history.points).toEqual([]);
    expect(lean.ftp).toBe(full.ftp);
    expect(lean.windowDays).toBe(42);
    expect(lean.sports).toEqual([{ sport: 'ride', workouts: 1 }]);
    const best = (s: number) => lean.windowBests.find((p) => p.durationS === s)?.watts;
    expect(best(300)).toBe(320);
    expect(best(1200)).toBeCloseTo((300 * 320 + 900 * 250) / 1200, 1);
    expect(lean.ftp).toBeCloseTo(0.95 * best(1200)!, 1);
    // the same values as the power curve of that window
    const curve = await getJson<{ current: { points: { durationS: number; watts: number }[] } }>(
      `/api/progress/power/curve?period=42d&compare=none&today=${TODAY}`,
    );
    expect(lean.windowBests.map((p) => [p.durationS, p.watts])).toEqual(curve.current.points.map((p) => [p.durationS, p.watts]));
  });

  it('has no bests for a window without power data', async () => {
    const r = await getJson<ProgressFtpResponse>(`/api/progress/power/ftp?today=2020-01-01&history=0`);
    expect(r.ftp).toBeNull();
    expect(r.windowBests).toEqual([]);
    expect(r.sports).toEqual([{ sport: 'ride', workouts: 1 }]); // power data exists, just not in that window
  });

  it('validates the flag', async () => {
    expect((await app.inject({ url: '/api/progress/power/ftp?history=maybe' })).statusCode).toBe(400);
    const yes = await getJson<ProgressFtpResponse>(`/api/progress/power/ftp?today=${TODAY}&history=1`);
    expect(yes.history.points.length).toBeGreaterThan(0);
  });
});
