import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ImportJob,
  MapsExplorerResponse,
  MapsHeatmapResponse,
  MapsRoutesResponse,
  MapsSegmentDetail,
  MapsSegmentSource,
  Page,
  WorkoutSummary,
} from '@cadence/shared';
import { generateSample } from '../scripts/sample/generate';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb, type Db } from '../src/db/db';

/** End to end: a real (small) synthetic Apple Health export through the importer and every maps derive step. */
describe('maps on imported data', () => {
  let dir: string;
  let db: Db;
  let app: FastifyInstance;

  async function waitForJob(id: string): Promise<ImportJob> {
    const t0 = Date.now();
    for (;;) {
      const job = (await app.inject({ url: `/api/import/jobs/${id}` })).json<ImportJob>();
      if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
      if (Date.now() - t0 > 90_000) throw new Error(`job ${id} still ${job.status}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  const get = async <T>(url: string): Promise<T> => {
    const res = await app.inject({ url });
    expect(res.statusCode, `${url}: ${res.body.slice(0, 300)}`).toBe(200);
    return res.json<T>();
  };
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-maps-import-'));
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
    expect(job.stats.warnings.filter((w) => /maps\./.test(w))).toEqual([]);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('derives tiles, signatures and routes for the imported GPS workouts', async () => {
    const routed = (
      db.prepare('SELECT COUNT(*) AS n FROM workouts WHERE has_route = 1').get() as { n: number }
    ).n;
    expect(routed).toBeGreaterThan(15);
    expect(count('maps_workout_geo')).toBeGreaterThan(routed * 0.9);
    expect(count('maps_workout_tiles')).toBeGreaterThan(routed * 5);
    const explorer = await get<MapsExplorerResponse>('/api/maps/explorer');
    expect(explorer.totals.tiles).toBeGreaterThan(5);
    expect(explorer.totals.workouts).toBeGreaterThan(15);
    expect(explorer.months.length).toBeGreaterThan(3);
    const heat = await get<MapsHeatmapResponse>('/api/maps/heatmap');
    expect(heat.items.length).toBe(
      routed -
        (
          db
            .prepare('SELECT COUNT(*) AS n FROM workouts WHERE has_route = 1 AND duplicate_of IS NOT NULL')
            .get() as { n: number }
        ).n,
    );
    const routes = await get<MapsRoutesResponse>('/api/maps/routes?min=1');
    expect(routes.items.length).toBeGreaterThan(3);
    // every route has an efforts-based summary that makes sense
    for (const r of routes.items) {
      expect(r.count).toBeGreaterThanOrEqual(1);
      expect(r.bestTimeS).toBeLessThanOrEqual(r.latestTimeS + r.firstTimeS);
      expect(r.distanceM).toBeGreaterThan(300);
    }
  });

  let segmentId = 0;
  it('cuts a segment from an imported run and finds at least that run', async () => {
    const runs = await get<Page<WorkoutSummary>>('/api/workouts?sport=run&hasRoute=true&limit=100');
    const w = runs.items.find((x) => (x.distanceM ?? 0) > 6000)!;
    const src = await get<MapsSegmentSource>(`/api/maps/segments/source/${w.id}`);
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/segments',
      payload: { workoutId: w.id, startM: src.totalM * 0.3, endM: src.totalM * 0.45, name: 'Integration' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const d = res.json<MapsSegmentDetail>();
    segmentId = d.segment.id;
    expect(d.efforts.some((e) => e.workoutId === w.id)).toBe(true);
    expect(d.segment.efforts).toBeGreaterThanOrEqual(1);
    // the effort of the source run takes about as long as the corresponding part of the run
    const own = d.efforts.find((e) => e.workoutId === w.id)!;
    expect(own.elapsedS).toBeGreaterThan(60);
    expect(own.avgSpeed).toBeGreaterThan(1.5);
  });

  it('survives a full rebuild without warnings and with the same efforts', async () => {
    const before = (await get<MapsSegmentDetail>(`/api/maps/segments/${segmentId}`)).efforts.map((e) => [
      e.workoutId,
      e.idx,
      e.elapsedS,
    ]);
    const routesBefore = (await get<MapsRoutesResponse>('/api/maps/routes?min=1')).items
      .map((r) => r.count)
      .sort();
    const res = await app.inject({ method: 'POST', url: '/api/import/rederive', payload: {} });
    expect(res.statusCode).toBe(202);
    const job = await waitForJob(res.json<ImportJob>().id);
    expect(job.status).toBe('done');
    expect(job.stats.warnings.filter((w) => /maps\./.test(w))).toEqual([]);
    const after = (await get<MapsSegmentDetail>(`/api/maps/segments/${segmentId}`)).efforts.map((e) => [
      e.workoutId,
      e.idx,
      e.elapsedS,
    ]);
    expect(after).toEqual(before);
    expect(
      (await get<MapsRoutesResponse>('/api/maps/routes?min=1')).items.map((r) => r.count).sort(),
    ).toEqual(routesBefore);
  });

  it('is wiped by a reset together with everything else', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/import/reset',
      payload: { confirm: 'DELETE' },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    for (const table of [
      'maps_workout_tiles',
      'maps_workout_geo',
      'maps_routes',
      'maps_segments',
      'maps_segment_efforts',
    ])
      expect(count(table), table).toBe(0);
    const explorer = await get<MapsExplorerResponse>('/api/maps/explorer');
    expect(explorer.totals.tiles).toBe(0);
    expect((await get<MapsHeatmapResponse>('/api/maps/heatmap')).items).toEqual([]);
  });
});
