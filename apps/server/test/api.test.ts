import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DailyMetric,
  HealthSample,
  ImportJob,
  Page,
  RecordTypeInfo,
  SportCount,
  WorkoutDetail,
  WorkoutStreams,
  WorkoutSummary,
} from '@cadence/shared';
import { generateSample } from '../scripts/sample/generate';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { openDb, type Db } from '../src/db/db';

let dir: string;
let zip: string;
let config: Config;
let db: Db;
let app: FastifyInstance;

async function waitForJob(id: string, timeoutMs = 60_000): Promise<ImportJob> {
  const t0 = Date.now();
  for (;;) {
    const job = (await app.inject({ url: `/api/import/jobs/${id}` })).json<ImportJob>();
    if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${id} still ${job.status}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const getJson = async <T>(url: string): Promise<T> => {
  const res = await app.inject({ url });
  expect(res.statusCode, `${url}: ${res.body.slice(0, 200)}`).toBe(200);
  return res.json<T>();
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-api-'));
  zip = path.join(dir, 'export.zip');
  await generateSample({ out: zip, size: 'small', seed: 7, endDate: '2026-06-30' });
  config = loadConfig({
    CADENCE_DATA_DIR: path.join(dir, 'data'),
    CADENCE_MODE: 'dev',
    CADENCE_ALLOW_LOCAL_IMPORT: '1',
    LOG_LEVEL: 'silent',
  });
  db = openDb(config.dbPath);
  migrateAll(db);
  app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('import API', () => {
  it('imports a local file as a job and reports progress', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/import/local', payload: { path: zip } });
    expect(res.statusCode).toBe(202);
    const queued = res.json<ImportJob>();
    expect(queued).toMatchObject({ kind: 'import', status: 'queued', sourceName: 'export.zip' });
    const job = await waitForJob(queued.id);
    expect(job.status).toBe('done');
    expect(job.error).toBeNull();
    expect(job.progress).toBe(1);
    expect(job.stats.recordsInserted).toBeGreaterThan(50_000);
    expect(job.stats.workoutsInserted).toBeGreaterThan(30);
    expect(job.finishedAt).toBeGreaterThanOrEqual(job.startedAt!);
    const list = await getJson<ImportJob[]>('/api/import/jobs');
    expect(list[0]!.id).toBe(queued.id);
    const status = await getJson<{ counts: { workouts: number; records: number } }>('/api/status');
    expect(status.counts.records).toBe(job.stats.recordsInserted);
  });

  it('rejects local imports when disabled and bad requests', async () => {
    config.allowLocalImport = false;
    expect(
      (await app.inject({ method: 'POST', url: '/api/import/local', payload: { path: zip } })).statusCode,
    ).toBe(403);
    config.allowLocalImport = true;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/import/local',
          payload: { path: '/does/not/exist.zip' },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/import/jobs/nope' })).statusCode).toBe(404);
  });

  it('accepts a multipart upload (field "file"), dedupes and deletes the temp file', async () => {
    const boundary = '----cadence-test-boundary';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="export.zip"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
      fs.readFileSync(zip),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/import/upload',
      payload: body,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(res.statusCode, res.body).toBe(202);
    const job = await waitForJob(res.json<ImportJob>().id);
    expect(job.status).toBe('done');
    expect(job.stats.recordsInserted).toBe(0); // same export again
    expect(job.stats.recordsSeen).toBeGreaterThan(50_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.readdirSync(config.uploadsDir)).toEqual([]);
  });

  it('queues a full rebuild of derived data', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/import/rederive' });
    expect(res.statusCode).toBe(202);
    const job = await waitForJob(res.json<ImportJob>().id);
    expect(job).toMatchObject({ kind: 'rederive', status: 'done' });
    expect(job.stats.workoutsDerived).toBeGreaterThan(30);
  });
});

describe('workout API', () => {
  let runId = 0;

  it('lists workouts with filters, search, sorting and paging', async () => {
    const page = await getJson<Page<WorkoutSummary>>('/api/workouts?limit=5');
    expect(page.items.length).toBe(5);
    expect(page.total).toBeGreaterThan(30);
    expect(page.items[0]!.startTs).toBeGreaterThan(page.items[4]!.startTs);
    const runs = await getJson<Page<WorkoutSummary>>('/api/workouts?sport=run,ride&hasRoute=true&limit=200');
    expect(
      runs.items.every((w) => (w.sport === 'run' || w.sport === 'ride') && w.hasRoute && w.polyline),
    ).toBe(true);
    // duplicates are excluded unless asked for
    const withDup = await getJson<Page<WorkoutSummary>>('/api/workouts?includeDuplicates=true&limit=1');
    expect(withDup.total).toBe(page.total + 1);
    const lauf = await getJson<Page<WorkoutSummary>>('/api/workouts?q=Lauf&limit=200');
    expect(lauf.total).toBeGreaterThan(5);
    expect(lauf.items.every((w) => w.sport === 'run')).toBe(true);
    const longest = await getJson<Page<WorkoutSummary>>('/api/workouts?sort=distance&order=desc&limit=3');
    expect(longest.items[0]!.distanceM!).toBeGreaterThanOrEqual(longest.items[1]!.distanceM!);
    expect((await app.inject({ url: '/api/workouts?sort=bogus' })).statusCode).toBe(400);
    runId = runs.items.find((w) => w.sport === 'run')!.id;
  });

  it('returns a workout detail with splits, best efforts (ranked) and events', async () => {
    const w = await getJson<WorkoutDetail>(`/api/workouts/${runId}`);
    expect(w.id).toBe(runId);
    expect(w.splitsMetric.length).toBeGreaterThan(3);
    expect(w.splitsImperial.length).toBeGreaterThan(2);
    expect(w.bestEfforts.map((e) => e.effort)).toContain('1k');
    expect(w.bestEfforts.every((e) => e.rank === null || (e.rank >= 1 && e.rank <= 3))).toBe(true);
    expect(w.bounds![0]).toBeLessThan(w.bounds![2]);
    expect(w.hrZones?.length).toBe(5);
    expect(w.events.some((e) => e.type === 'segment')).toBe(true);
    expect(w.meta.HKTimeZone).toBe('Europe/Vienna');
    expect((await app.inject({ url: '/api/workouts/999999' })).statusCode).toBe(404);
    // somebody holds rank 1 for the 1K
    const all = await getJson<Page<WorkoutSummary>>('/api/workouts?sport=run&hasRoute=true&limit=200');
    const ranks = (
      await Promise.all(all.items.map((x) => getJson<WorkoutDetail>(`/api/workouts/${x.id}`)))
    ).flatMap((d) => d.bestEfforts.filter((e) => e.effort === '1k').map((e) => e.rank));
    expect(ranks.filter((r) => r === 1).length).toBe(1);
    expect(ranks.filter((r) => r === 2).length).toBe(1);
  });

  it('serves streams (gzip passthrough or JSON) and GPX', async () => {
    const plain = await app.inject({
      url: `/api/workouts/${runId}/streams`,
      headers: { 'accept-encoding': 'identity' },
    });
    const s = plain.json<WorkoutStreams>();
    expect(s.t.length).toBeGreaterThan(100);
    expect(s.hr!.length).toBe(s.t.length);
    const gz = await app.inject({
      url: `/api/workouts/${runId}/streams`,
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(zlib.gunzipSync(gz.rawPayload).toString()).t.length).toBe(s.t.length);
    const gpx = await app.inject({ url: `/api/workouts/${runId}/gpx?lang=de` });
    expect(gpx.statusCode).toBe(200);
    expect(gpx.headers['content-type']).toMatch(/gpx/);
    expect(gpx.headers['content-disposition']).toMatch(/attachment; filename=".*\.gpx"/);
    expect(gpx.body).toContain('<trkpt lat="');
    expect(gpx.body).toContain('<gpxtpx:hr>');
    expect(gpx.body).toMatch(/<name>Lauf am (Morgen|Mittag|Nachmittag|Abend)|<name>Lauf in der Nacht/);
    expect(gpx.body.split('<trkpt').length - 1).toBe(s.t.length);
  });

  it('patches name, sport and hidden', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/workouts/${runId}`,
      payload: { name: 'Prater loop', notes: 'felt good' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<WorkoutDetail>()).toMatchObject({ name: 'Prater loop', notes: 'felt good' });
    const found = await getJson<Page<WorkoutSummary>>('/api/workouts?q=prater');
    expect(found.items.map((w) => w.id)).toContain(runId);
    const before = await getJson<Page<WorkoutSummary>>('/api/workouts?limit=1');
    await app.inject({ method: 'PATCH', url: `/api/workouts/${runId}`, payload: { hidden: true } });
    expect((await getJson<Page<WorkoutSummary>>('/api/workouts?limit=1')).total).toBe(before.total - 1);
    expect((await getJson<Page<WorkoutSummary>>('/api/workouts?includeHidden=true&limit=1')).total).toBe(
      before.total,
    );
    expect(
      (await app.inject({ method: 'PATCH', url: `/api/workouts/${runId}`, payload: { sport: 'skydiving' } }))
        .statusCode,
    ).toBe(400);
    const walk = await app.inject({
      method: 'PATCH',
      url: `/api/workouts/${runId}`,
      payload: { sport: 'walk', hidden: false },
    });
    expect(walk.json<WorkoutDetail>().sport).toBe('walk');
    // the PATCH queued a derive job for this workout; let it finish
    const jobs = await getJson<ImportJob[]>('/api/import/jobs');
    for (const j of jobs.filter((x) => x.status === 'queued' || x.status === 'running'))
      await waitForJob(j.id);
    const sports = await getJson<SportCount[]>('/api/meta/sports');
    expect(sports.find((x) => x.sport === 'walk')!.count).toBeGreaterThan(0);
    expect(sports.reduce((a, x) => a + x.count, 0)).toBe(before.total);
  });
});

describe('metrics API', () => {
  it('lists record types with stats', async () => {
    const types = await getJson<RecordTypeInfo[]>('/api/metrics/types');
    const steps = types.find((t) => t.identifier === 'HKQuantityTypeIdentifierStepCount')!;
    expect(steps).toMatchObject({ kind: 'quantity', unit: 'count', aggregation: 'sum' });
    expect(steps.count).toBeGreaterThan(1000);
    expect(steps.firstTs).toBeLessThan(steps.lastTs!);
    expect(types.find((t) => t.identifier === 'HKCategoryTypeIdentifierSleepAnalysis')!.aggregation).toBe(
      'duration',
    );
  });

  it('returns daily metrics and raw samples', async () => {
    const days = await getJson<DailyMetric[]>(
      '/api/metrics/daily?metric=HKQuantityTypeIdentifierRestingHeartRate&fromDay=2026-06-01&toDay=2026-06-30',
    );
    expect(days.length).toBe(30);
    expect(days[0]!.day).toBe('2026-06-01');
    expect(days[0]!.value).toBeGreaterThan(40);
    const sleep = await getJson<DailyMetric[]>(
      '/api/metrics/daily?metric=HKCategoryTypeIdentifierSleepAnalysis:AsleepDeep',
    );
    expect(sleep.length).toBeGreaterThan(60);
    const hr = await getJson<HealthSample[]>(
      '/api/metrics/samples?type=HKQuantityTypeIdentifierHeartRate&limit=10&order=desc',
    );
    expect(hr.length).toBe(10);
    expect(hr[0]!.startTs).toBeGreaterThanOrEqual(hr[9]!.startTs);
    expect(hr[0]!.source).toMatch(/Apple Watch/);
    expect((await app.inject({ url: '/api/metrics/daily' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/metrics/samples?type=HKNope' })).statusCode).toBe(404);
  });
});

describe('reset', () => {
  it('requires confirmation and wipes all data', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/import/reset', payload: {} })).statusCode).toBe(
      400,
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/import/reset',
      payload: { confirm: 'DELETE' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; deleted: Record<string, number>; job: ImportJob }>();
    expect(body.deleted.records).toBeGreaterThan(50_000);
    await waitForJob(body.job.id);
    expect((await getJson<Page<WorkoutSummary>>('/api/workouts')).total).toBe(0);
    expect(await getJson<RecordTypeInfo[]>('/api/metrics/types')).toEqual([]);
    const status = await getJson<{ counts: { workouts: number; records: number } }>('/api/status');
    expect(status.counts).toMatchObject({ workouts: 0, records: 0 });
  });
});
