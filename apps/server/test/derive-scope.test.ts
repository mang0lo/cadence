import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { updateSettings } from '../src/core/settings';
import { all, get, openDb, run, type Db } from '../src/db/db';
import { DERIVE_VERSION } from '../src/derive/context';
import { runDerive } from '../src/derive/run';

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
