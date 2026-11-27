import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActivityListPage } from '@cadence/shared';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { all, openDb, run, type Db } from '../src/db/db';
import { DERIVE_VERSION } from '../src/derive/context';
import { listWhere, orderBy } from '../src/features/activities/queries';

/**
 * The activities list and its CSV export filter periods by local days, each activity in its own time zone (like the
 * heatmap and the calendar), not by the browser's.
 */
let dir: string;
let db: Db;
let app: FastifyInstance;

let ext = 0;
/** A run at a local wall clock time `iso` ('YYYY-MM-DDTHH:MM') with the UTC offset `tzMin`. */
function runAt(name: string, iso: string, tzMin: number) {
  const start = Date.parse(`${iso}:00Z`) / 1000 - tzMin * 60;
  run(
    db,
    `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, name, start_ts, end_ts, tz_min, duration_s,
       distance_m, derived_version)
     VALUES (1, ?, 'HKWorkoutActivityTypeRunning', 'run', ?, ?, ?, ?, 1800, 5000, ?)`,
    [`k${ext++}`, name, start, start + 1800, tzMin, DERIVE_VERSION],
  );
}

const list = async (query: string) => {
  const res = await app.inject({ url: `/api/activities/list?${query}` });
  expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  return res
    .json<ActivityListPage>()
    .items.map((x) => x.name)
    .sort();
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-w2-days-'));
  const config = loadConfig({ CADENCE_DATA_DIR: path.join(dir, 'data'), CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
  db = openDb(config.dbPath);
  migrateAll(db);
  runAt('new-york-late', '2026-01-31T23:30', -300); // Feb 1 04:30 UTC
  runAt('tokyo-early', '2026-02-01T06:00', 540); // Jan 31 21:00 UTC
  runAt('berlin', '2026-02-01T12:00', 60);
  runAt('march', '2026-03-01T08:00', 60);
  app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('activities list by local days', () => {
  it('puts every activity on its own local day', async () => {
    expect(await list('fromDay=2026-01-31&toDay=2026-01-31')).toEqual(['new-york-late']);
    expect(await list('fromDay=2026-02-01&toDay=2026-02-01')).toEqual(['berlin', 'tokyo-early']);
    expect(await list('fromDay=2026-02-01')).toEqual(['berlin', 'march', 'tokyo-early']);
    expect(await list('toDay=2026-02-28')).toEqual(['berlin', 'new-york-late', 'tokyo-early']);
  });

  it('counts the totals over the same activities', async () => {
    const res = await app.inject({ url: '/api/activities/list?fromDay=2026-02-01&toDay=2026-02-28' });
    expect(res.json<ActivityListPage>()).toMatchObject({ total: 2, totals: { count: 2, distanceM: 10000 } });
  });

  it('exports the same selection as CSV', async () => {
    const res = await app.inject({ url: '/api/activities/export.csv?fromDay=2026-01-31&toDay=2026-01-31' });
    expect(res.statusCode).toBe(200);
    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(2); // header + one activity
    expect(lines[1]).toContain('new-york-late');
  });

  it('rejects days that do not exist', async () => {
    for (const q of ['fromDay=2026-02-30', 'toDay=2026-13-01', 'fromDay=yesterday'])
      expect((await app.inject({ url: `/api/activities/list?${q}` })).statusCode, q).toBe(400);
    expect((await app.inject({ url: '/api/activities/export.csv?toDay=2026-02-31' })).statusCode).toBe(400);
  });

  it('still reads the default order from the start index', () => {
    const { sql, params } = listWhere(1, { fromDay: '2026-02-01', toDay: '2026-02-28' });
    const plan = all<{ detail: string }>(
      db,
      `EXPLAIN QUERY PLAN SELECT id FROM workouts WHERE ${sql} ORDER BY ${orderBy('start', 'desc')} LIMIT 20`,
      params,
    ).map((r) => r.detail);
    expect(plan.join(' | ')).toContain('ix_workouts_start');
    expect(plan.join(' | ')).not.toContain('TEMP B-TREE');
  });
});
