import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActivityAnalysis, ImportJob, MapsHeatmapResponse, Page, WorkoutStreams, WorkoutSummary } from '@cadence/shared';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb, type Db } from '../src/db/db';
import { decodePolylineParts, destination, type LatLon } from '../src/lib/geo';

/**
 * A ride started in Rostock, paused for two hours on a train and continued in Berlin (a real-world export pattern):
 * the jump must not be distance, climbing, a line on the maps, explorer tiles or a GPX segment.
 */
const ROSTOCK: LatLon = [54.0887, 12.1405];
const BERLIN: LatLon = [52.52, 13.405];
const T0 = Date.UTC(2026, 5, 20, 8, 0, 0) / 1000; // 10:00 CEST

const P2 = (n: number) => String(n).padStart(2, '0');
/** Apple's date format at +0200. */
function fmt(ts: number): string {
  const d = new Date((ts + 7200) * 1000);
  return `${d.getUTCFullYear()}-${P2(d.getUTCMonth() + 1)}-${P2(d.getUTCDate())} ${P2(d.getUTCHours())}:${P2(d.getUTCMinutes())}:${P2(d.getUTCSeconds())} +0200`;
}
const iso = (ts: number) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');

function legPoints(from: LatLon, bearing: number, seconds: number, start: number, ele: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < seconds; i++) {
    const [lat, lon] = destination(from[0], from[1], bearing, i * 7);
    out.push(
      `   <trkpt lon="${lon.toFixed(6)}" lat="${lat.toFixed(6)}"><ele>${(ele + Math.sin(i / 50)).toFixed(2)}</ele><time>${iso(start + i)}</time><extensions><speed>7.0</speed><hAcc>4.0</hAcc></extensions></trkpt>`,
    );
  }
  return out;
}

function writeExport(dir: string): string {
  const root = path.join(dir, 'apple_health_export');
  fs.mkdirSync(path.join(root, 'workout-routes'), { recursive: true });
  const resume = T0 + 600 + 7200;
  const end = resume + 600;
  const gpx = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Apple Health Export" xmlns="http://www.topografix.com/GPX/1/1">',
    ' <trk><name>Route</name><trkseg>',
    ...legPoints(ROSTOCK, 90, 600, T0, 10),
    ...legPoints(BERLIN, 0, 600, resume, 60),
    ' </trkseg></trk>',
    '</gpx>',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'workout-routes', 'route_2026-06-20_10.00am.gpx'), gpx);
  const src = 'sourceName="Apple Watch" sourceVersion="12.0"';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="de_DE">
 <ExportDate value="${fmt(end + 3600)}"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeCycling" duration="20" durationUnit="min" ${src} creationDate="${fmt(end + 9)}" startDate="${fmt(T0)}" endDate="${fmt(end)}">
  <MetadataEntry key="HKTimeZone" value="Europe/Berlin"/>
  <MetadataEntry key="HKIndoorWorkout" value="0"/>
  <WorkoutEvent type="HKWorkoutEventTypePause" date="${fmt(T0 + 600)}"/>
  <WorkoutEvent type="HKWorkoutEventTypeResume" date="${fmt(resume)}"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceCycling" startDate="${fmt(T0)}" endDate="${fmt(end)}" sum="8.4" unit="km"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" startDate="${fmt(T0)}" endDate="${fmt(end)}" sum="310" unit="kcal"/>
  <WorkoutRoute ${src} creationDate="${fmt(end + 12)}" startDate="${fmt(T0)}" endDate="${fmt(end)}">
   <FileReference path="/workout-routes/route_2026-06-20_10.00am.gpx"/>
  </WorkoutRoute>
 </Workout>
</HealthData>
`;
  fs.writeFileSync(path.join(root, 'export.xml'), xml);
  return root;
}

describe('a ride paused for a train ride and continued in another city', () => {
  let dir: string;
  let db: Db;
  let app: FastifyInstance;
  let id: number;

  const getJson = async <T>(url: string): Promise<T> => {
    const res = await app.inject({ url });
    expect(res.statusCode, `${url}: ${res.body.slice(0, 300)}`).toBe(200);
    return res.json<T>();
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-breaks-'));
    const folder = writeExport(dir);
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
    const res = await app.inject({ method: 'POST', url: '/api/import/local', payload: { path: folder } });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const jobId = res.json<ImportJob>().id;
    for (const t0 = Date.now(); ; ) {
      const job = await getJson<ImportJob>(`/api/import/jobs/${jobId}`);
      if (job.status === 'done') break;
      if (job.status === 'failed' || Date.now() - t0 > 60_000) throw new Error(`import ${job.status}: ${job.error}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    const list = await getJson<Page<WorkoutSummary>>('/api/workouts');
    expect(list.total).toBe(1);
    id = list.items[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the distance and climbing of the ride only', async () => {
    const w = (await getJson<Page<WorkoutSummary>>('/api/workouts')).items[0]!;
    expect(w.distanceM).toBeCloseTo(8400, -1);
    expect(w.elevationGainM ?? 0).toBeLessThan(15);
    const s = await getJson<WorkoutStreams>(`/api/workouts/${id}/streams`);
    expect(s.breaks).toEqual([600]);
    expect(s.dist![s.dist!.length - 1]!).toBeLessThan(9000);
  });

  it('names the start and the end of the one-way activity after the real places', async () => {
    const w = (await getJson<Page<WorkoutSummary>>('/api/workouts')).items[0]!;
    expect(w.place).toBe('Rostock');
    expect(w.placeEnd).toMatch(/Berlin|Mitte|Gesundbrunnen|Prenzlauer Berg|Pankow|Wedding/);
    const detail = await getJson<WorkoutSummary>(`/api/workouts/${id}`);
    expect(detail.place).toBe('Rostock');
  });

  it('finds the activity by the places it started and ended in', async () => {
    const total = async (q: string) =>
      (await getJson<Page<WorkoutSummary>>(`/api/activities/list?q=${encodeURIComponent(q)}`)).total;
    expect(await total('rostock')).toBe(1);
    expect(await total('Rost')).toBe(1);
    expect(await total('hamburg')).toBe(0);
    const end = (await getJson<Page<WorkoutSummary>>('/api/workouts')).items[0]!.placeEnd!;
    expect(await total(end)).toBe(1);
  });

  it('stores and serves the route in two parts', async () => {
    const w = (await getJson<Page<WorkoutSummary>>('/api/workouts')).items[0]!;
    const parts = decodePolylineParts(w.polyline!);
    expect(parts).toHaveLength(2);
    expect(parts[0]![0]![0]).toBeCloseTo(ROSTOCK[0], 2);
    expect(parts[1]![0]![0]).toBeCloseTo(BERLIN[0], 2);
    const heat = await getJson<MapsHeatmapResponse>('/api/maps/heatmap');
    expect(decodePolylineParts(heat.items[0]!.polyline)).toHaveLength(2);
  });

  it('exports one GPX track segment per part', async () => {
    const res = await app.inject({ url: `/api/workouts/${id}/gpx` });
    expect(res.statusCode).toBe(200);
    expect(res.body.match(/<trkseg>/g)).toHaveLength(2);
  });

  it('does not count explorer tiles or a route along the train line', () => {
    const tiles = (db.prepare('SELECT COUNT(*) AS n FROM maps_workout_tiles WHERE z = 14').get() as { n: number }).n;
    // two 4 km rides touch a handful of tiles; the 180 km line to Berlin would add about a hundred
    expect(tiles).toBeGreaterThan(1);
    expect(tiles).toBeLessThan(20);
    expect((db.prepare('SELECT COUNT(*) AS n FROM maps_workout_geo').get() as { n: number }).n).toBe(0);
  });

  it('finds no climb in the jump between the parts', async () => {
    const a = await getJson<ActivityAnalysis>(`/api/activities/${id}/analysis`);
    expect(a.climbs ?? []).toEqual([]);
  });

  it('refuses a segment across the break', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/maps/segments',
      payload: { workoutId: id, startM: 3000, endM: 5500, name: 'Across' },
    });
    expect(res.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/maps/segments',
      payload: { workoutId: id, startM: 500, endM: 3500, name: 'Rostock' },
    });
    expect(ok.statusCode, ok.body).toBe(201);
  });
});
