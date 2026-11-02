import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ActivitiesSummary,
  ActivityAnalysis,
  ActivityListPage,
  ActivityNav,
  ActivitySimilar,
  ImportJob,
  SportCount,
} from '@cadence/shared';
import { generateSample } from '../scripts/sample/generate';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { get, openDb, type Db } from '../src/db/db';

let dir: string;
let db: Db;
let app: FastifyInstance;

const getJson = async <T>(url: string): Promise<T> => {
  const res = await app.inject({ url });
  expect(res.statusCode, `${url}: ${res.body.slice(0, 300)}`).toBe(200);
  return res.json<T>();
};

async function waitForJob(id: string): Promise<ImportJob> {
  for (;;) {
    const job = (await app.inject({ url: `/api/import/jobs/${id}` })).json<ImportJob>();
    if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-activities-'));
  const zip = path.join(dir, 'export.zip');
  await generateSample({ out: zip, size: 'small', seed: 11, endDate: '2026-06-30' });
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
  const res = await app.inject({ method: 'POST', url: '/api/import/local', payload: { path: zip } });
  const job = await waitForJob(res.json<ImportJob>().id);
  expect(job.status).toBe('done');
}, 180_000);

afterAll(async () => {
  await app?.close();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('activities API', () => {
  it('precomputes analyses in the derive step', () => {
    const n = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM activities_analysis')!.n;
    const w = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM workouts')!.n;
    expect(n).toBe(w);
  });

  it('summarizes totals per sport, year and week', async () => {
    const s = await getJson<ActivitiesSummary>('/api/activities/summary?today=2026-06-24&weekStart=1');
    const sports = await getJson<SportCount[]>('/api/meta/sports');
    expect(s.allTime.count).toBe(sports.reduce((a, b) => a + b.count, 0));
    expect(s.sports.map((x) => x.sport)[0]).toBe(sports[0]!.sport);
    expect(s.weekStartDay).toBe('2026-06-22');
    expect(s.yearStartDay).toBe('2026-01-01');
    expect(s.week).toHaveLength(7);
    expect(s.week[0]!.day).toBe('2026-06-22');
    expect(s.week.reduce((a, d) => a + d.totals.count, 0)).toBe(s.thisWeek.count);
    expect(s.thisYear.count).toBeLessThanOrEqual(s.allTime.count);
    const sunday = await getJson<ActivitiesSummary>('/api/activities/summary?today=2026-06-24&weekStart=0');
    expect(sunday.weekStartDay).toBe('2026-06-21');
    expect((await app.inject({ url: '/api/activities/summary?today=2026-13-45' })).statusCode).toBe(400);
  });

  it('lists activities with totals, sorting and medals', async () => {
    const page = await getJson<ActivityListPage>('/api/activities/list?limit=5');
    expect(page.items).toHaveLength(5);
    expect(page.total).toBe(page.totals.count);
    expect(page.items[0]!.startTs).toBeGreaterThanOrEqual(page.items[4]!.startTs);
    const runs = await getJson<ActivityListPage>('/api/activities/list?sport=run&sort=pace&order=desc&limit=200');
    expect(runs.items.every((w) => w.sport === 'run')).toBe(true);
    const speeds = runs.items.map((w) => w.avgSpeed ?? 0);
    expect(speeds).toEqual([...speeds].sort((a, b) => b - a));
    expect(runs.totals.distanceM).toBeCloseTo(
      runs.items.reduce((a, w) => a + (w.distanceM ?? 0), 0),
      0,
    );
    const medals = runs.items.flatMap((w) => w.medals);
    expect(medals.length).toBeGreaterThan(0);
    expect(medals.every((m) => m.rank >= 1 && m.rank <= 3)).toBe(true);
    // exactly one rank-1 medal per effort among visible runs
    const firsts = medals.filter((m) => m.rank === 1).map((m) => m.effort);
    expect(new Set(firsts).size).toBe(firsts.length);
    const searched = await getJson<ActivityListPage>('/api/activities/list?q=Lauf&limit=1');
    expect(searched.total).toBe(runs.total);
    const gps = await getJson<ActivityListPage>('/api/activities/list?hasRoute=true&limit=200');
    expect(gps.items.every((w) => w.hasRoute)).toBe(true);
    expect((await app.inject({ url: '/api/activities/list?sort=bogus' })).statusCode).toBe(400);
  });

  it('includes hidden activities only when asked', async () => {
    const first = (await getJson<ActivityListPage>('/api/activities/list?limit=1')).items[0]!;
    await app.inject({ method: 'PATCH', url: `/api/workouts/${first.id}`, payload: { hidden: true } });
    const without = await getJson<ActivityListPage>('/api/activities/list?limit=1');
    expect(without.items[0]!.id).not.toBe(first.id);
    const withHidden = await getJson<ActivityListPage>('/api/activities/list?limit=1&includeHidden=1');
    expect(withHidden.items[0]).toMatchObject({ id: first.id, hidden: true });
    await app.inject({ method: 'PATCH', url: `/api/workouts/${first.id}`, payload: { hidden: false } });
  });

  it('navigates to previous and next activities', async () => {
    const page = await getJson<ActivityListPage>('/api/activities/list?limit=3');
    const [newest, middle, oldest] = page.items as [ActivityListPage['items'][0], ActivityListPage['items'][0], ActivityListPage['items'][0]];
    const nav = await getJson<ActivityNav>(`/api/activities/${middle.id}/nav`);
    expect(nav.next?.id).toBe(newest.id);
    expect(nav.prev?.id).toBe(oldest.id);
    expect((await getJson<ActivityNav>(`/api/activities/${newest.id}/nav`)).next).toBeNull();
    expect((await app.inject({ url: '/api/activities/999999/nav' })).statusCode).toBe(404);
  });

  it('serves a cached analysis', async () => {
    const run = (await getJson<ActivityListPage>('/api/activities/list?sport=run&hasRoute=true&limit=1')).items[0]!;
    const a = await getJson<ActivityAnalysis>(`/api/activities/${run.id}/analysis`);
    expect(a.workoutId).toBe(run.id);
    expect(a.hasStreams).toBe(true);
    expect(a.avgSpeed).toBeGreaterThan(1.5);
    const again = await getJson<ActivityAnalysis>(`/api/activities/${run.id}/analysis`);
    expect(again.computedAt).toBe(a.computedAt);
    // a rename touches updated_at → recomputed
    db.exec(`UPDATE workouts SET updated_at = updated_at + 5 WHERE id = ${run.id}`);
    const fresh = await getJson<ActivityAnalysis>(`/api/activities/${run.id}/analysis`);
    expect(fresh.workoutId).toBe(run.id);
    expect((await app.inject({ url: '/api/activities/999999/analysis' })).statusCode).toBe(404);
  });

  it('finds similar activities with a rank', async () => {
    const run = (await getJson<ActivityListPage>('/api/activities/list?sport=run&hasRoute=true&limit=1')).items[0]!;
    const s = await getJson<ActivitySimilar>(`/api/activities/${run.id}/similar`);
    expect(s.basis).toBe('distance');
    expect(s.items.filter((x) => x.current)).toHaveLength(1);
    expect(s.items.every((x) => x.sport === 'run')).toBe(true);
    expect(s.items.every((x) => x.distanceM! >= s.min && x.distanceM! <= s.max)).toBe(true);
    expect(s.rank).toBeGreaterThanOrEqual(1);
    expect(s.rank).toBeLessThanOrEqual(s.count);
    const times = s.items.map((x) => x.startTs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const yoga = (await getJson<ActivityListPage>('/api/activities/list?sport=yoga&limit=1')).items[0];
    if (yoga) expect((await getJson<ActivitySimilar>(`/api/activities/${yoga.id}/similar`)).basis).toBe('duration');
  });
});
