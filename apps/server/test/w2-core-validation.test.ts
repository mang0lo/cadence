import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { get, openDb, run, type Db } from '../src/db/db';
import { gzipJson } from '../src/lib/gzip';
import { zDay } from '../src/lib/params';
import { dayString } from '../src/lib/time';

let dir: string;
let db: Db;
let app: FastifyInstance;
let workoutId: number;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-w2-validation-'));
  const config = loadConfig({ CADENCE_DATA_DIR: path.join(dir, 'data'), CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
  db = openDb(config.dbPath);
  migrateAll(db);
  app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();
  workoutId = Number(
    run(
      db,
      `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s)
       VALUES (1, 'w1', 'HKWorkoutActivityTypeRunning', 'run', 1780000000, 1780001800, 120, 1800)`,
    ).lastInsertRowid,
  );
});

afterAll(async () => {
  await app?.close();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const patch = (url: string, payload: unknown) => app.inject({ method: 'PATCH', url, payload: payload as object });

describe('sports from requests', () => {
  it('refuses keys of the object prototype as the sport of a workout', async () => {
    for (const sport of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const res = await patch(`/api/workouts/${workoutId}`, { sport });
      expect(res.statusCode, sport).toBe(400);
      expect(res.json().error.code).toBe('invalid_request');
    }
    expect(get<{ sport: string }>(db, 'SELECT sport FROM workouts WHERE id = ?', [workoutId])!.sport).toBe('run');
    const ok = await patch(`/api/workouts/${workoutId}`, { sport: 'hike' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().sport).toBe('hike');
  });

  it('exports a workout whose stored sport is a prototype key (accepted before this check) without a function body', async () => {
    const id = Number(
      run(
        db,
        `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s)
         VALUES (1, 'w-proto', 'HKWorkoutActivityTypeRunning', 'constructor', 1780100000, 1780100060, 0, 60)`,
      ).lastInsertRowid,
    );
    const streams = { t: [0, 30, 60], lat: [52.5, 52.5001, 52.5002], lon: [13.4, 13.4001, 13.4002] };
    run(db, 'INSERT INTO workout_streams (workout_id, version, points, data) VALUES (?, 1, 3, ?)', [
      id,
      gzipJson(streams),
    ]);
    const res = await app.inject({ url: `/api/workouts/${id}/gpx` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<type>constructor</type>');
    expect(res.body).not.toContain('native code');
    // the default title falls back to the 'other' sport, not to Object's constructor
    expect(res.body).toContain('Workout');
  });
});

describe('days in requests', () => {
  const IMPOSSIBLE = ['2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '2023-02-29', '2026-1-01', ' 2026-01-01', '0000-00-00'];

  it('zDay takes calendar days only', () => {
    for (const d of ['2024-02-29', '2026-01-01', '2026-12-31', '1970-01-01']) expect(zDay.safeParse(d).success, d).toBe(true);
    for (const d of IMPOSSIBLE) expect(zDay.safeParse(d).success, d).toBe(false);
  });

  it('refuses impossible days in the daily metrics range with 400', async () => {
    for (const d of IMPOSSIBLE) {
      for (const key of ['fromDay', 'toDay']) {
        const res = await app.inject({ url: `/api/metrics/daily?metric=HKQuantityTypeIdentifierStepCount&${key}=${encodeURIComponent(d)}` });
        expect(res.statusCode, `${key}=${d}`).toBe(400);
        expect(res.json().error.code).toBe('invalid_request');
      }
    }
    const ok = await app.inject({ url: '/api/metrics/daily?metric=HKQuantityTypeIdentifierStepCount&fromDay=2024-02-29&toDay=2026-02-28' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual([]);
  });

  it('refuses an impossible sinceDay of a partial rebuild with 400 and queues nothing', async () => {
    const jobs = () => get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM import_jobs')!.n;
    const before = jobs();
    for (const d of IMPOSSIBLE) {
      const res = await app.inject({ method: 'POST', url: '/api/import/rederive', payload: { workoutIds: [workoutId], sinceDay: d } });
      expect(res.statusCode, d).toBe(400);
    }
    expect(jobs()).toBe(before);
  });
});

describe('PATCH /api/settings', () => {
  const idle = async () => {
    for (let i = 0; i < 500 && app.jobs.busy(1); i++) await new Promise((r) => setTimeout(r, 10));
  };
  const lastDerive = () =>
    JSON.parse(
      get<{ options: string }>(db, "SELECT options FROM import_jobs WHERE kind = 'rederive' ORDER BY created_at DESC, rowid DESC LIMIT 1")!
        .options,
    ) as Record<string, unknown>;

  it('derives zones and effort again after a heart rate change without recomputing the daily metrics', async () => {
    await idle();
    for (const body of [{ maxHr: 187 }, { hrZoneMethod: 'hrr' }, { birthDate: '1985-06-15' }, { sex: 'female' }]) {
      const res = await patch('/api/settings', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(200);
      expect(lastDerive(), JSON.stringify(body)).toMatchObject({ origin: 'settings', workoutIds: [], records: false });
      await idle();
    }
  });

  it('takes a birth date only when it is a calendar day from 1900 up to today', async () => {
    const tomorrow = dayString(Math.floor(Date.now() / 86_400_000) + 2);
    for (const birthDate of ['1985-02-30', '1985-13-01', '1899-12-31', '0985-06-15', tomorrow, '1985-6-15', 'yesterday']) {
      const res = await patch('/api/settings', { birthDate });
      expect(res.statusCode, birthDate).toBe(400);
      expect(res.json().error.code).toBe('invalid_request');
    }
    expect((await app.inject({ url: '/api/settings' })).json().birthDate).toBe('1985-06-15');
    for (const birthDate of ['1900-01-01', '2000-02-29', dayString(Math.floor(Date.now() / 86_400_000)), null]) {
      const res = await patch('/api/settings', { birthDate });
      expect(res.statusCode, String(birthDate)).toBe(200);
      expect(res.json().birthDate).toBe(birthDate);
    }
    await idle();
  });

  it('refuses custom zone limits that do not ascend', async () => {
    for (const hrZones of [[120, 120, 150, 170], [150, 140, 160, 175], [120, 140, 160, 155]]) {
      const res = await patch('/api/settings', { hrZoneMethod: 'custom', hrZones });
      expect(res.statusCode, JSON.stringify(hrZones)).toBe(400);
    }
    expect((await app.inject({ url: '/api/settings' })).json().hrZones).toBeNull();
    const ok = await patch('/api/settings', { hrZoneMethod: 'custom', hrZones: [120, 140, 160, 175] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ hrZoneMethod: 'custom', hrZones: [120, 140, 160, 175] });
    expect((await patch('/api/settings', { hrZones: null })).statusCode).toBe(200);
    await idle();
  });
});
