import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { get, openDb, run, type Db } from '../src/db/db';
import { gzipJson } from '../src/lib/gzip';

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
