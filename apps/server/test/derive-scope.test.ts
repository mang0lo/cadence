import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { updateSettings } from '../src/core/settings';
import { all, get, openDb, run, type Db } from '../src/db/db';
import { DERIVE_VERSION } from '../src/derive/context';
import { recomputeDailyMetrics, refreshTypeStats } from '../src/derive/daily';
import { runDerive } from '../src/derive/run';
import { executeJob } from '../src/import/run-job';
import { createHealthFixture } from './health-fixture';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-derive-scope-'));
  db = openDb(path.join(dir, 'cadence.db'));
  migrateAll(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const T0 = 1_780_000_000; // 2026-05-28

function workout(
  key: string,
  o: { start?: number; duration?: number; source?: string; avgHr?: number | null; distance?: number | null } = {},
): number {
  const start = o.start ?? T0;
  const duration = o.duration ?? 3600;
  run(
    db,
    `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, avg_hr,
       distance_m, source_name, derived_version)
     VALUES (1, ?, 'HKWorkoutActivityTypeRunning', 'run', ?, ?, 120, ?, ?, ?, ?, ?)`,
    [key, start, start + duration, duration, o.avgHr ?? null, o.distance ?? null, o.source ?? 'Apple Watch', DERIVE_VERSION],
  );
  return get<{ id: number }>(db, 'SELECT id FROM workouts WHERE ext_key = ?', [key])!.id;
}

/** Heart-rate samples every 10 s (what core.workouts builds the HR stream and histogram from). */
function heartRate(from: number, to: number, bpm: number, source = 'Apple Watch'): void {
  run(
    db,
    `INSERT OR IGNORE INTO record_types (identifier, kind, unit, aggregation)
     VALUES ('HKQuantityTypeIdentifierHeartRate', 'quantity', 'count/min', 'avg')`,
  );
  run(db, 'INSERT OR IGNORE INTO sources (name) VALUES (?)', [source]);
  const type = get<{ id: number }>(db, "SELECT id FROM record_types WHERE identifier = 'HKQuantityTypeIdentifierHeartRate'")!.id;
  const src = get<{ id: number }>(db, 'SELECT id FROM sources WHERE name = ?', [source])!.id;
  for (let t = from; t < to; t += 10)
    run(
      db,
      `INSERT INTO records (athlete_id, type_id, start_ts, hash, end_ts, tz_min, value, source_id)
       VALUES (1, ?, ?, ?, ?, 120, ?, ?)`,
      [type, t, t, t, bpm, src],
    );
}

const derive = (workoutIds: number[] | 'all') =>
  runDerive({ db, athleteId: 1, workoutIds, sinceDay: '2026-05-27', typeSince: new Map() });

describe('derive change set', () => {
  it('reports a new heart-rate basis instead of widening the scope to every workout', async () => {
    const a = workout('a');
    const b = workout('b', { start: T0 + 86400 });
    heartRate(T0, T0 + 3600, 150);
    heartRate(T0 + 86400, T0 + 86400 + 3600, 150);
    await derive('all');
    const effortOf = (id: number) => get<{ effort: number }>(db, 'SELECT effort FROM workouts WHERE id = ?', [id])!.effort;
    const before = effortOf(a);

    // nothing changed: no new basis
    let d = await derive([b]);
    expect(d.workoutIds).toEqual([b]);
    expect(d.changes.effortBasis).toBe(false);

    updateSettings(db, 1, { maxHr: 170 });
    d = await derive([b]);
    // workoutIds keeps its meaning (feature caches are not rebuilt) …
    expect(d.workoutIds).toEqual([b]);
    // … while every workout's effort follows the new basis
    expect(d.changes.effortBasis).toBe(true);
    expect(effortOf(a)).toBeGreaterThan(before);
    expect(d.changes.recordTypes).toEqual(new Map());
  });

  it('reports workouts outside the scope whose duplicate mark changed', async () => {
    const copy = workout('strava', { source: 'Strava', distance: 10_000 });
    await derive('all');
    expect(get(db, 'SELECT duplicate_of FROM workouts WHERE id = ?', [copy])).toEqual({ duplicate_of: null });

    // the watch's own recording of the same run arrives (with heart rate): the old copy becomes the duplicate
    heartRate(T0, T0 + 3600, 150);
    const watch = workout('watch', { source: 'Apple Watch', distance: 10_000 });
    const d = await derive([watch]);
    expect(all(db, 'SELECT id, duplicate_of FROM workouts ORDER BY id')).toEqual([
      { id: copy, duplicate_of: watch },
      { id: watch, duplicate_of: null },
    ]);
    expect(d.workoutIds).toEqual([watch]);
    expect(d.changes.duplicateFlips).toEqual([copy]);
  });
});

describe('relative effort', () => {
  it('extrapolates a heart-rate histogram with a dropout to the whole workout', async () => {
    const full = workout('full');
    const gap = workout('gap', { start: T0 + 86400 });
    heartRate(T0, T0 + 3600, 150);
    // the strap lost contact after 40 of 60 minutes
    heartRate(T0 + 86400, T0 + 86400 + 2400, 150);
    await derive('all');
    const row = (id: number) =>
      get<{ effort: number; trimp: number; hr_zones: string }>(db, 'SELECT effort, trimp, hr_zones FROM workouts WHERE id = ?', [id])!;
    // more HR data never means less load than the average-HR fallback: the gap counts like the rest of the run
    expect(row(gap).effort).toBeGreaterThan(row(full).effort * 0.95);
    expect(row(gap).effort).toBeLessThan(row(full).effort * 1.05);
    // time in zones stays what was measured
    const zones = (id: number) => (JSON.parse(row(id).hr_zones) as number[]).reduce((a, b) => a + b, 0);
    expect(zones(gap)).toBeLessThan(zones(full) * 0.7);
  });
});

describe('record type stats', () => {
  it('stays exact when only the records after the checkpoint are counted again', () => {
    run(db, "INSERT INTO record_types (id, identifier, kind, unit, aggregation) VALUES (7, 'HKQuantityTypeIdentifierStepCount', 'quantity', 'count', 'sum')");
    run(db, "INSERT INTO sources (id, name) VALUES (1, 'iPhone')");
    let hash = 1;
    const add = (start: number, n: number, step = 3600) => {
      for (let i = 0; i < n; i++)
        run(
          db,
          'INSERT INTO records (athlete_id, type_id, start_ts, hash, end_ts, tz_min, value, source_id) VALUES (1, 7, ?, ?, ?, 60, 10, 1)',
          [start + i * step, hash++, start + i * step + 600],
        );
    };
    const stats = () => get<{ count: number; first_ts: number; last_ts: number }>(db, 'SELECT count, first_ts, last_ts FROM record_type_stats WHERE type_id = 7');
    const truth = () => get(db, 'SELECT COUNT(*) AS count, MIN(start_ts) AS first_ts, MAX(start_ts) AS last_ts FROM records WHERE type_id = 7');
    add(T0, 24 * 100); // 100 days, hourly
    refreshTypeStats(db, 1, 7);
    expect(stats()).toEqual(truth());

    // an import of the next days: only the recent records are counted
    add(T0 + 100 * 86400, 24 * 3);
    refreshTypeStats(db, 1, 7, T0 + 100 * 86400);
    expect(stats()).toEqual(truth());
    add(T0 + 103 * 86400, 24 * 40);
    refreshTypeStats(db, 1, 7, T0 + 103 * 86400);
    expect(stats()).toEqual(truth());

    // a late sync of old data (before the checkpoint) is counted in full
    add(T0 - 10 * 86400, 5, 60);
    refreshTypeStats(db, 1, 7, T0 - 10 * 86400);
    expect(stats()).toEqual(truth());
    add(T0 + 5 * 86400 + 30, 7, 60);
    refreshTypeStats(db, 1, 7, T0 + 5 * 86400 + 30);
    expect(stats()).toEqual(truth());

    // no records left: no stats
    run(db, 'DELETE FROM records WHERE type_id = 7');
    refreshTypeStats(db, 1, 7, T0 + 200 * 86400);
    expect(stats()).toBeUndefined();
  });

  it('finds the last day of a type from its latest records', () => {
    run(db, "INSERT INTO record_types (id, identifier, kind, unit, aggregation) VALUES (8, 'HKCategoryTypeIdentifierSleepAnalysis', 'category', NULL, 'duration')");
    run(db, "INSERT INTO sources (id, name) VALUES (1, 'Watch')");
    const sleep = (bed: number, wake: number, hash: number) =>
      run(
        db,
        "INSERT INTO records (athlete_id, type_id, start_ts, hash, end_ts, tz_min, text, source_id) VALUES (1, 8, ?, ?, ?, 0, 'AsleepCore', 1)",
        [bed, hash, wake],
      );
    const night = Math.floor(T0 / 86400) * 86400;
    sleep(night - 30 * 86400 - 3600, night - 30 * 86400 + 6 * 3600, 1);
    // the last session starts before midnight and ends on the next day (sleep counts for the day it ends)
    sleep(night - 3600, night + 7 * 3600, 2);
    recomputeDailyMetrics(db, 1, { id: 8, identifier: 'HKCategoryTypeIdentifierSleepAnalysis', kind: 'category', aggregation: 'duration' }, null);
    expect(all(db, "SELECT day, value FROM daily_metrics WHERE metric = 'HKCategoryTypeIdentifierSleepAnalysis:AsleepCore' ORDER BY day")).toEqual([
      { day: new Date((night - 30 * 86400) * 1000).toISOString().slice(0, 10), value: 420 },
      { day: new Date(night * 1000).toISOString().slice(0, 10), value: 480 },
    ]);
  });
});

describe('rederive of an edited workout', () => {
  it('leaves the daily health metrics alone', async () => {
    const a = workout('a');
    heartRate(T0, T0 + 3600, 150);
    await runDerive({ db, athleteId: 1, workoutIds: 'all', sinceDay: null });
    const day = '2026-05-28';
    const hr = () =>
      get<{ value: number }>(db, "SELECT value FROM daily_metrics WHERE metric = 'HKQuantityTypeIdentifierHeartRate' AND day = ?", [day])
        ?.value;
    expect(hr()).toBe(150);
    run(db, "UPDATE daily_metrics SET value = 999 WHERE metric = 'HKQuantityTypeIdentifierHeartRate'");
    const rederive = (options: object) =>
      executeJob(
        db,
        { id: 'r', kind: 'rederive', athleteId: 1, sourcePath: null, options: { origin: 'workout', workoutIds: [a], sinceDay: day, ...options } },
        { progress: () => {}, checkCancelled: () => {}, log: () => {} },
      );
    const stats = await rederive({ records: false });
    expect(stats.workoutsDerived).toBe(1);
    expect(hr()).toBe(999);
    // without `records: false` (jobs queued by older versions) every record type is recomputed from that day
    await rederive({});
    expect(hr()).toBe(150);
  });

  it('is what hiding a workout or changing its sport queues', async () => {
    const fx = await createHealthFixture();
    try {
      run(
        fx.db,
        `INSERT INTO workouts (id, athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, derived_version)
         VALUES (5, 1, 'w5', 'HKWorkoutActivityTypeRunning', 'run', ?, ?, 120, 3600, ?)`,
        [T0, T0 + 3600, DERIVE_VERSION],
      );
      for (const payload of [{ hidden: true }, { sport: 'walk' }]) {
        const res = await fx.app.inject({ method: 'PATCH', url: '/api/workouts/5', payload });
        expect(res.statusCode).toBe(200);
      }
      const jobs = all<{ options: string }>(fx.db, "SELECT options FROM import_jobs WHERE kind = 'rederive'");
      expect(jobs.length).toBeGreaterThan(0);
      for (const j of jobs)
        expect(JSON.parse(j.options)).toMatchObject({ origin: 'workout', workoutIds: [5], sinceDay: '2026-05-28', records: false });
    } finally {
      await fx.close();
    }
  });
});
