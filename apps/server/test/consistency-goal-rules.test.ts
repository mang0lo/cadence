import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Goal } from '@cadence/shared';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb, run, type Db } from '../src/db/db';
import { DERIVE_VERSION } from '../src/derive/context';
import { refreshDailyActivity } from '../src/derive/daily';

/** Rules around goals: which sports a goal accepts. */
let dir: string;
let db: Db;
let app: FastifyInstance;

let ext = 0;
function addRun(day: string, distanceM = 8_000): void {
  const start = Date.parse(`${day}T07:00:00+02:00`) / 1000;
  run(
    db,
    `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, distance_m, derived_version)
     VALUES (1, ?, 'HKWorkoutActivityTypeRunning', 'run', ?, ?, 120, 2700, ?, ?)`,
    [`k${ext++}`, start, start + 2700, distanceM, DERIVE_VERSION],
  );
}

const post = (payload: object) => app.inject({ method: 'POST', url: '/api/consistency/goals', payload });
const patch = (id: number, payload: object) => app.inject({ method: 'PATCH', url: `/api/consistency/goals/${id}`, payload });

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-goal-rules-'));
  const config = loadConfig({ CADENCE_DATA_DIR: path.join(dir, 'data'), CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
  db = openDb(config.dbPath);
  migrateAll(db);
  for (let i = 1; i <= 28; i += 3) addRun(`2026-05-${String(i).padStart(2, '0')}`);
  refreshDailyActivity(db, 1);
  app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('goal validation', () => {
  it('rejects sports that are only inherited object keys', async () => {
    for (const sport of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      expect((await post({ period: 'week', sport, metric: 'time', target: 3600 })).statusCode, sport).toBe(400);
    }
    const ok = await post({ period: 'week', sport: 'run', metric: 'time', target: 3600 });
    expect(ok.statusCode).toBe(201);
    const id = ok.json<Goal>().id;
    expect((await patch(id, { sport: 'toString' })).statusCode).toBe(400);
    expect((await patch(id, { sport: 'ride' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/consistency/goals/${id}` })).statusCode).toBe(200);
  });
});
