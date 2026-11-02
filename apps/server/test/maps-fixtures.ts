import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { WorkoutStreams } from '@cadence/shared';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb, run, type Db } from '../src/db/db';
import mapsFeature from '../src/features/maps';
import type { DeriveContext } from '../src/features/types';
import { bounds, cumulativeDistance, encodePolylineArrays, haversine, simplifyIndices, type LatLon } from '../src/lib/geo';
import { gzipJson } from '../src/lib/gzip';

/** Deterministic pseudo random numbers (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TestTrack {
  /** seconds since start */
  t: number[];
  lat: number[];
  lon: number[];
  dist: number[];
  ele: number[];
  hr: number[];
}

export interface TrackOptions {
  /** m/s (default 3) */
  speed?: number;
  /** Gaussian-ish GPS noise in meters (default 0) */
  noiseM?: number;
  seed?: number;
  /** elevation in meters at a distance along the track (default flat 200 m) */
  ele?: (distM: number) => number;
  /** Seconds the athlete stands still at the very start (default 0). */
  startDelayS?: number;
}

const M_PER_DEG_LAT = 111_195;

/** 1 Hz GPS track walking a polyline of [lat, lon] waypoints at constant speed. */
export function trackAlong(points: LatLon[], opts: TrackOptions = {}): TestTrack {
  const speed = opts.speed ?? 3;
  const rand = rng(opts.seed ?? 1);
  const noise = opts.noiseM ?? 0;
  const segs: { a: LatLon; b: LatLon; len: number; start: number }[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = haversine(a[0], a[1], b[0], b[1]);
    segs.push({ a, b, len, start: total });
    total += len;
  }
  const t: number[] = [];
  const lat: number[] = [];
  const lon: number[] = [];
  const ele: number[] = [];
  const delay = opts.startDelayS ?? 0;
  const n = Math.ceil(total / speed) + 1;
  let si = 0;
  for (let k = -delay; k <= n; k++) {
    const d = Math.min(total, Math.max(0, k * speed));
    while (si < segs.length - 1 && segs[si]!.start + segs[si]!.len < d) si++;
    const s = segs[si]!;
    const f = s.len > 0 ? Math.min(1, Math.max(0, (d - s.start) / s.len)) : 0;
    let la = s.a[0] + (s.b[0] - s.a[0]) * f;
    let lo = s.a[1] + (s.b[1] - s.a[1]) * f;
    if (noise > 0) {
      la += ((rand() + rand() + rand() - 1.5) * noise) / M_PER_DEG_LAT;
      lo += ((rand() + rand() + rand() - 1.5) * noise) / (M_PER_DEG_LAT * Math.cos((la * Math.PI) / 180));
    }
    t.push(k + delay + 1);
    lat.push(Math.round(la * 1e6) / 1e6);
    lon.push(Math.round(lo * 1e6) / 1e6);
    ele.push(opts.ele ? opts.ele(d) : 200);
    if (d >= total && k * speed >= total) break;
  }
  const dist = Array.from(cumulativeDistance(lat, lon), (x) => Math.round(x * 10) / 10);
  const hr = t.map((_, i) => 140 + Math.round(10 * Math.sin(i / 60)));
  return { t, lat, lon, dist, ele, hr };
}

/** Points on a circle (closed loop) around a center, `n` vertices, radius in meters. */
export function circle(center: LatLon, radiusM: number, n = 72, clockwise = true): LatLon[] {
  const out: LatLon[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((clockwise ? i : n - i) / n) * Math.PI * 2;
    out.push([
      center[0] + (Math.cos(a) * radiusM) / M_PER_DEG_LAT,
      center[1] + (Math.sin(a) * radiusM) / (M_PER_DEG_LAT * Math.cos((center[0] * Math.PI) / 180)),
    ]);
  }
  return out;
}

/** Straight line of `lengthM` meters from `from` heading `bearingDeg` (default east), as two waypoints. */
export function line(from: LatLon, lengthM: number, bearingDeg = 90): LatLon[] {
  const b = (bearingDeg * Math.PI) / 180;
  return [
    from,
    [
      from[0] + (Math.cos(b) * lengthM) / M_PER_DEG_LAT,
      from[1] + (Math.sin(b) * lengthM) / (M_PER_DEG_LAT * Math.cos((from[0] * Math.PI) / 180)),
    ],
  ];
}

export interface TestWorkout {
  sport?: string;
  startTs?: number;
  tzMin?: number;
  name?: string;
  hidden?: boolean;
  track?: TestTrack | null;
  timezone?: string | null;
  duplicateOf?: number | null;
}

/** Insert a workout (and its stream) the way the core derive step would have stored it. Returns the id. */
export function insertWorkout(db: Db, w: TestWorkout = {}): number {
  const sport = w.sport ?? 'run';
  const startTs = w.startTs ?? 1_700_000_000;
  const tr = w.track ?? null;
  const dur = tr ? tr.t[tr.t.length - 1]! : 1800;
  const extKey = `test|${sport}|${startTs}|${Math.random()}`;
  const distance = tr ? tr.dist[tr.dist.length - 1]! : null;
  let polyline: string | null = null;
  let bb: ReturnType<typeof bounds> = null;
  if (tr) {
    const keep = simplifyIndices(tr.lat, tr.lon, 5);
    polyline = encodePolylineArrays(tr.lat, tr.lon, keep);
    bb = bounds(tr.lat, tr.lon);
  }
  const r = run(
    db,
    `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, name, start_ts, end_ts, tz_min, timezone, duration_s,
       moving_s, distance_m, avg_hr, has_route, start_lat, start_lon, end_lat, end_lon, min_lat, min_lon, max_lat, max_lon,
       polyline, hidden, duplicate_of)
     VALUES (1, ?, 'HKWorkoutActivityTypeRunning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      extKey,
      sport,
      w.name ?? '',
      startTs,
      startTs + Math.round(dur),
      w.tzMin ?? 60,
      w.timezone ?? 'Europe/Vienna',
      dur,
      dur,
      distance,
      tr ? 145 : null,
      tr ? 1 : 0,
      tr?.lat[0] ?? null,
      tr?.lon[0] ?? null,
      tr?.lat[tr.lat.length - 1] ?? null,
      tr?.lon[tr.lon.length - 1] ?? null,
      bb?.[1] ?? null,
      bb?.[0] ?? null,
      bb?.[3] ?? null,
      bb?.[2] ?? null,
      polyline,
      w.hidden ? 1 : 0,
      w.duplicateOf ?? null,
    ],
  );
  const id = r.lastInsertRowid;
  if (tr) {
    const dto: WorkoutStreams = {
      t: tr.t,
      lat: tr.lat,
      lon: tr.lon,
      ele: tr.ele,
      dist: tr.dist,
      hr: tr.hr,
      moving: tr.t.map(() => 1),
    };
    run(db, 'INSERT INTO workout_streams (workout_id, version, points, data) VALUES (?, 1, ?, ?)', [
      id,
      tr.t.length,
      gzipJson(dto),
    ]);
  }
  return id;
}

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  dir: string;
  close: () => Promise<void>;
}

/** Fresh temp database with all migrations applied and the HTTP app on top (no import needed). */
export async function makeApp(): Promise<TestApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-maps-'));
  const config = loadConfig({ CADENCE_DATA_DIR: path.join(dir, 'data'), CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
  const db = openDb(config.dbPath);
  migrateAll(db);
  const app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();
  return {
    app,
    db,
    dir,
    close: async () => {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const VIENNA: LatLon = [48.2082, 16.3738];

/** Run the maps derive steps (optionally only some of them) the way the import worker would. */
export async function runMapsSteps(db: Db, workoutIds: number[] | 'all', only?: string[]): Promise<void> {
  const ctx: DeriveContext = {
    db,
    athleteId: 1,
    workoutIds,
    sinceDay: null,
    report: () => {},
    checkCancelled: () => {},
    log: () => {},
  };
  for (const step of mapsFeature.deriveSteps ?? []) {
    if (!only || only.includes(step.id)) await step.run(ctx);
  }
}
