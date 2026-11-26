import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkoutStreams } from '@cadence/shared';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { all, get, openDb, run, type Db } from '../src/db/db';
import { DERIVE_VERSION } from '../src/derive/context';
import { deriveAnalyses } from '../src/features/activities/store';
import { workoutCachesStep } from '../src/features/progress/derive';
import { ensurePowerBests, powerWorkoutsToRefresh, storePowerBests } from '../src/features/progress/power-curve';
import { ensureWorkoutMetrics, storeWorkoutMetrics, workoutsToRefresh } from '../src/features/progress/workout-metrics';
import type { DeriveContext } from '../src/features/types';
import * as gzip from '../src/lib/gzip';
import { gzipJson } from '../src/lib/gzip';

// count stream decodes
vi.mock('../src/lib/gzip', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/lib/gzip')>();
  return { ...m, gunzipJson: vi.fn(m.gunzipJson) };
});

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-progress-caches-'));
  db = openDb(path.join(dir, 'data', 'cadence.db'));
  migrateAll(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let ext = 0;

/** A derived 30-minute workout at 150 bpm with distance (and 200 W for rides), one sample every 5 s. */
function workout(sport: 'run' | 'ride'): number {
  const start = 1_760_000_000 + ext * 86400;
  const t: number[] = [];
  const hr: number[] = [];
  const dist: number[] = [];
  const power: number[] = [];
  for (let s = 0; s <= 1800; s += 5) {
    t.push(s);
    hr.push(150);
    dist.push(s * (sport === 'run' ? 3 : 8));
    power.push(200);
  }
  const st: WorkoutStreams = sport === 'ride' ? { t, hr, dist, power } : { t, hr, dist };
  const id = run(
    db,
    `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, distance_m,
       avg_power, derived_version, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, 60, 1800, ?, ?, ?, 1000)`,
    [
      `c${ext++}`,
      sport === 'run' ? 'HKWorkoutActivityTypeRunning' : 'HKWorkoutActivityTypeCycling',
      sport,
      start,
      start + 1800,
      dist.at(-1)!,
      sport === 'ride' ? 200 : null,
      DERIVE_VERSION,
    ],
  ).lastInsertRowid;
  run(db, 'INSERT INTO workout_streams (workout_id, version, points, data) VALUES (?, 1, ?, ?)', [id, t.length, gzipJson(st)]);
  return id;
}

/** Derive context; `computed` collects the workouts each step reported at its end ("<n> workouts", none → 0). */
function ctx(workoutIds: number[] | 'all', computed: number[] = []): DeriveContext {
  return {
    db,
    athleteId: 1,
    workoutIds,
    sinceDay: null,
    report: (f, message) => {
      if (f !== 1) return;
      if (message === undefined) computed.push(0);
      else if (/^\d+ workouts$/.test(message)) computed.push(Number.parseInt(message, 10));
    },
    checkCancelled: () => {},
    log: () => {},
  };
}

const ids = (table: string) =>
  all<{ id: number }>(db, `SELECT workout_id AS id FROM ${table} ORDER BY workout_id`).map((r) => r.id);
const stateOf = (id: number) =>
  get<{ source_updated_at: number; power_s: number }>(
    db,
    'SELECT source_updated_at, power_s FROM progress_power_state WHERE workout_id = ?',
    [id],
  );
const bestsOf = (id: number) =>
  get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM progress_power_bests WHERE workout_id = ?', [id])!.n;
const metricsOf = (id: number) =>
  get<{ source_updated_at: number; hr_speed: string | null }>(
    db,
    'SELECT source_updated_at, hr_speed FROM progress_workout_metrics WHERE workout_id = ?',
    [id],
  );

describe('progress caches', () => {
  it('the request-time fill leaves new workouts to a queued or running import', () => {
    const a = workout('run');
    const b = workout('ride');
    run(db, "INSERT INTO import_jobs (id, athlete_id, kind, status) VALUES ('job', 1, 'import', 'running')");
    expect(ensureWorkoutMetrics(db, 1, null)).toBe(0);
    expect(ensurePowerBests(db, 1)).toBe(0);
    expect(ids('progress_workout_metrics')).toEqual([]);
    expect(ids('progress_power_state')).toEqual([]);
    run(db, "UPDATE import_jobs SET status = 'queued'");
    expect(ensureWorkoutMetrics(db, 1, null)).toBe(0);
    // once the job is over, missing rows are filled on use
    run(db, "UPDATE import_jobs SET status = 'failed'");
    expect(ensureWorkoutMetrics(db, 1, null)).toBe(2);
    expect(ensurePowerBests(db, 1)).toBe(2);
    expect(ids('progress_workout_metrics')).toEqual([a, b]);
    expect(ids('progress_power_state')).toEqual([a, b]);
  });

  it('a computation never replaces the rows of a newer derivation', () => {
    const b = workout('ride');
    // read before the import's derive changed the workout ...
    const [staleM] = workoutsToRefresh(db, 1, [b]);
    const [staleP] = powerWorkoutsToRefresh(db, 1, [b]);
    run(db, 'UPDATE workouts SET updated_at = 2000 WHERE id = ?', [b]);
    workoutCachesStep.run(ctx([b]));
    const rows = () => ({ state: stateOf(b), bests: bestsOf(b), metrics: metricsOf(b) });
    const fresh = rows();
    expect(fresh.state!.source_updated_at).toBe(2000);
    expect(fresh.state!.power_s).toBeGreaterThan(1700);
    expect(fresh.bests).toBeGreaterThan(0);
    expect(fresh.metrics!.source_updated_at).toBe(2000);
    expect(fresh.metrics!.hr_speed).not.toBeNull();
    // ... and written after it: dropped (here: computed when the workout had no power and no stream yet)
    run(db, 'UPDATE workout_streams SET data = ? WHERE workout_id = ?', [gzipJson({ t: [] }), b]);
    storeWorkoutMetrics(db, [staleM!]);
    storePowerBests(db, [{ ...staleP!, power: null }]);
    expect(rows()).toEqual(fresh);
  });

  it('the request-time fill refreshes rows computed from an older derivation', () => {
    const a = workout('run');
    const b = workout('ride');
    workoutCachesStep.run(ctx('all'));
    const fresh = { state: stateOf(b), bests: bestsOf(b), metrics: metricsOf(a) };
    // e.g. a lost write: the rows still describe the workouts before their last derivation
    run(db, 'UPDATE progress_power_state SET source_updated_at = 999, power_s = 0 WHERE workout_id = ?', [b]);
    run(db, 'DELETE FROM progress_power_bests WHERE workout_id = ?', [b]);
    run(db, 'UPDATE progress_workout_metrics SET source_updated_at = 999, hr_speed = NULL WHERE workout_id = ?', [a]);
    expect(ensurePowerBests(db, 1)).toBe(1);
    expect(ensureWorkoutMetrics(db, 1, 'run')).toBe(1);
    expect({ state: stateOf(b), bests: bestsOf(b), metrics: metricsOf(a) }).toEqual(fresh);
    expect(fresh.metrics!.hr_speed).not.toBeNull();
    expect(ensurePowerBests(db, 1)).toBe(0);
    expect(ensureWorkoutMetrics(db, 1, null)).toBe(0);
  });

  it('derive steps also fill the rows an interrupted run left out', () => {
    const a = workout('run');
    const b = workout('ride');
    const c = workout('ride');
    // the import of c also catches up a and b
    const n: number[] = [];
    workoutCachesStep.run(ctx([c], n));
    expect(n).toEqual([3]);
    expect(ids('progress_workout_metrics')).toEqual([a, b, c]);
    expect(ids('progress_power_state')).toEqual([a, b, c]);
    // listed workouts are always recomputed, nothing else is
    workoutCachesStep.run(ctx([a], n));
    workoutCachesStep.run(ctx([], n));
    expect(n).toEqual([3, 1, 0]);
    // a stale row of one cache recomputes only that cache
    run(db, 'UPDATE progress_power_state SET version = 0 WHERE workout_id = ?', [b]);
    run(db, 'UPDATE progress_workout_metrics SET hr_speed = NULL WHERE workout_id = ?', [b]);
    workoutCachesStep.run(ctx([], n));
    expect(n).toEqual([3, 1, 0, 1]);
    expect(metricsOf(b)!.hr_speed).toBeNull();
  });

  it('one pass decodes each stream once for both caches', () => {
    const a = workout('run');
    const b = workout('ride');
    const c = workout('ride');
    const decode = vi.mocked(gzip.gunzipJson);
    decode.mockClear();
    workoutCachesStep.run(ctx('all'));
    // the run has no power: only its metrics read the stream
    expect(decode).toHaveBeenCalledTimes(3);
    expect(ids('progress_workout_metrics')).toEqual([a, b, c]);
    expect(ids('progress_power_state')).toEqual([a, b, c]);
    expect([a, b, c].map((id) => metricsOf(id)!.hr_speed !== null)).toEqual([true, true, true]);
    expect([a, b, c].map(bestsOf).map((x) => x > 0)).toEqual([false, true, true]);
  });

  it('the server start fills missing rows in the background', async () => {
    const a = workout('run');
    const b = workout('ride');
    deriveAnalyses(ctx('all')); // activity analyses are current: only the progress caches are missing
    const config = loadConfig({ CADENCE_DATA_DIR: path.join(dir, 'data'), CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
    const app = await buildApp(config, db, { jobRunner: 'inline' });
    try {
      await app.ready();
      for (let i = 0; i < 400 && app.jobs.busy(1); i++) await new Promise((r) => setTimeout(r, 10));
      const jobs = all<{ status: string; options: string }>(db, "SELECT status, options FROM import_jobs WHERE kind = 'rederive'");
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.status).toBe('done');
      expect(JSON.parse(jobs[0]!.options)).toMatchObject({ origin: 'upgrade', workoutIds: [] });
      expect(ids('progress_workout_metrics')).toEqual([a, b]);
      expect(ids('progress_power_state')).toEqual([a, b]);
    } finally {
      await app.close();
    }
    // nothing missing: no job at the next start
    const again = await buildApp(config, db, { jobRunner: 'inline' });
    await again.ready();
    expect(again.jobs.busy(1)).toBe(false);
    await again.close();
  });
});
