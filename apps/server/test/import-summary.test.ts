import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImportJob, ImportSummary } from '@cadence/shared';
import { generateSample } from '../scripts/sample/generate';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { all, get, openDb, run, type Db } from '../src/db/db';

let dir: string;
let zip: string;
let db: Db;
let app: FastifyInstance;

async function importZip(): Promise<ImportJob> {
  const res = await app.inject({ method: 'POST', url: '/api/import/local', payload: { path: zip } });
  expect(res.statusCode, res.body).toBeLessThan(300);
  const id = res.json<ImportJob>().id;
  for (;;) {
    const job = (await app.inject({ url: `/api/import/jobs/${id}` })).json<ImportJob>();
    if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-summary-'));
  zip = path.join(dir, 'export.zip');
  await generateSample({ out: zip, size: 'small', seed: 21, endDate: '2026-06-30' });
  const config = loadConfig({
    CADENCE_DATA_DIR: path.join(dir, 'data'),
    CADENCE_MODE: 'dev',
    CADENCE_ALLOW_LOCAL_IMPORT: '1',
    LOG_LEVEL: 'silent',
  });
  db = openDb(config.dbPath);
  migrateAll(db);
  app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("what's new after an import", () => {
  let first: ImportSummary;

  it('summarizes a first import without listing every record', async () => {
    const job = await importZip();
    expect(job.status).toBe('done');
    first = job.stats.summary!;
    const visible = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM workouts WHERE hidden = 0 AND duplicate_of IS NULL')!.n;
    expect(first.initial).toBe(true);
    expect(first.count).toBe(visible);
    expect(first.sports.reduce((a, s) => a + s.count, 0)).toBe(visible);
    expect(first.latest).toHaveLength(5);
    expect(first.latest[0]!.startTs).toBeGreaterThanOrEqual(first.latest[1]!.startTs);
    expect(first.fromDay! <= first.toDay!).toBe(true);
    // records, tiles and trophies of a first import would only repeat the totals
    expect(first.highlights).toEqual([]);
  });

  it('lists what a later import brought: activities, records and trophies', async () => {
    // the workout holding the fastest run best effort, plus the two newest runs, "were not imported yet"
    const pr = get<{ workout_id: number; effort: string }>(
      db,
      `SELECT be.workout_id, be.effort FROM best_efforts be JOIN workouts w ON w.id = be.workout_id
       WHERE be.sport = 'run' AND w.hidden = 0 ORDER BY be.distance_m DESC, be.elapsed_s LIMIT 1`,
    )!;
    const newest = all<{ id: number }>(db, "SELECT id FROM workouts WHERE sport = 'run' ORDER BY start_ts DESC LIMIT 2").map(
      (r) => r.id,
    );
    // the fastest effort of the most frequent route
    const route = get<{ route_id: number; n: number }>(
      db,
      `SELECT g.route_id, COUNT(*) AS n FROM maps_workout_geo g JOIN workouts w ON w.id = g.workout_id
       WHERE g.route_id IS NOT NULL AND w.hidden = 0 GROUP BY g.route_id ORDER BY n DESC LIMIT 1`,
    )!;
    expect(route.n).toBeGreaterThanOrEqual(2);
    const routeBest = get<{ id: number }>(
      db,
      `SELECT w.id FROM maps_workout_geo g JOIN workouts w ON w.id = g.workout_id WHERE g.route_id = ? AND w.hidden = 0
       ORDER BY COALESCE(NULLIF(w.moving_s, 0), w.duration_s) LIMIT 1`,
      [route.route_id],
    )!.id;
    const removed = [...new Set([pr.workout_id, ...newest, routeBest])];
    const sports = new Map<string, number>();
    for (const r of all<{ sport: string }>(db, `SELECT sport FROM workouts WHERE id IN (${removed.join(',')})`))
      sports.set(r.sport, (sports.get(r.sport) ?? 0) + 1);
    run(db, `DELETE FROM workouts WHERE id IN (${removed.join(',')})`);
    // and a trophy that the next import earns again counts as new
    const trophy = get<{ key: string }>(
      db,
      "SELECT key FROM consistency_achievements WHERE earned_day IS NOT NULL AND kind = 'activities' ORDER BY threshold LIMIT 1",
    )!;
    run(db, 'UPDATE consistency_achievements SET earned_day = NULL, first_seen_at = NULL WHERE key = ?', [trophy.key]);

    const job = await importZip();
    expect(job.status).toBe('done');
    const s = job.stats.summary!;
    expect(s.initial).toBe(false);
    expect(s.count).toBe(removed.length);
    expect(new Map(s.sports.map((x) => [x.sport, x.count]))).toEqual(sports);
    expect(s.latest).toHaveLength(Math.min(5, removed.length));

    const records = s.highlights.filter((h) => h.feature === 'activities' && h.kind === 'record');
    expect(records.some((h) => h.data.effort === pr.effort && h.data.rank === 1)).toBe(true);
    const newIds = new Set(all<{ id: number }>(db, `SELECT id FROM workouts ORDER BY id DESC LIMIT ${removed.length}`).map((r) => r.id));
    expect(records.every((h) => newIds.has(h.workoutId!))).toBe(true);

    // the re-imported fastest effort is the route's new best again
    const best = s.highlights.find((h) => h.feature === 'maps' && h.kind === 'routeBest');
    expect(best?.data.routeId).toBeTypeOf('number');
    expect(Number(best!.data.timeS)).toBeLessThanOrEqual(Number(best!.data.previousS));

    const trophies = s.highlights.filter((h) => h.feature === 'consistency' && h.kind === 'trophy');
    expect(trophies.map((h) => h.data.key)).toContain(trophy.key);

    // kept with the job, so the import screen can show it later
    const list = (await app.inject({ url: '/api/import/jobs' })).json<ImportJob[]>();
    expect(list.find((j) => j.id === job.id)?.stats.summary?.count).toBe(removed.length);
  });

  it('reports nothing new for an unchanged re-import', async () => {
    const job = await importZip();
    expect(job.status).toBe('done');
    expect(job.stats.summary).toMatchObject({ count: 0, sports: [], latest: [], highlights: [] });
  });
});
