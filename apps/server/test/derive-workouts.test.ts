import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkoutStatistic } from '@cadence/shared';
import { migrateAll } from '../src/app';
import { get, openDb, run, type Db } from '../src/db/db';
import { DeriveCache, deriveWorkout, workoutsStep } from '../src/derive/workouts';

const T0 = 1_780_000_000; // 2026-05-28
const HR = 1;
const STEPS = 2;
const CYCLING_CADENCE = 3;
const WATCH = 1;
const PHONE = 2;

let db: Db;
let hash = 1;

beforeEach(() => {
  db = openDb(':memory:');
  migrateAll(db);
  run(db, "INSERT INTO sources (id, name) VALUES (1, 'Apple Watch'), (2, 'iPhone'), (3, 'Runkeeper')");
  run(
    db,
    `INSERT INTO record_types (id, identifier, kind, unit, aggregation) VALUES
       (1, 'HKQuantityTypeIdentifierHeartRate', 'quantity', 'count/min', 'avg'),
       (2, 'HKQuantityTypeIdentifierStepCount', 'quantity', 'count', 'sum'),
       (3, 'HKQuantityTypeIdentifierCyclingCadence', 'quantity', 'count/min', 'avg')`,
  );
});
afterEach(() => db.close());

function rec(typeId: number, sourceId: number, start: number, end: number, value: number): void {
  run(
    db,
    'INSERT INTO records (athlete_id, type_id, start_ts, hash, end_ts, value, source_id) VALUES (1, ?, ?, ?, ?, ?, ?)',
    [typeId, start, hash++, end, value, sourceId],
  );
}

const stat = (type: string, sum: number): WorkoutStatistic => ({
  type: `HKQuantityTypeIdentifier${type}`,
  sum,
  average: null,
  minimum: null,
  maximum: null,
  unit: null,
});

/** A GPS-less workout of `minutes` from T0, with Watch heart rate every 10 s (so it gets streams). */
function workout(sport: 'run' | 'ride', source: string, minutes: number, stats: WorkoutStatistic[] = []): number {
  const end = T0 + minutes * 60;
  const id = run(
    db,
    `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, duration_s, source_name, stats)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `test|${sport}|${T0}`,
      sport === 'run' ? 'HKWorkoutActivityTypeRunning' : 'HKWorkoutActivityTypeCycling',
      sport,
      T0,
      end,
      minutes * 60,
      source,
      JSON.stringify(stats),
    ],
  ).lastInsertRowid;
  for (let t = T0; t <= end; t += 10) rec(HR, WATCH, t, t, 150);
  return id;
}

function derived(id: number) {
  deriveWorkout(db, new DeriveCache(db), 1, id);
  return get<{ step_count: number | null; avg_cadence: number | null }>(
    db,
    'SELECT step_count, avg_cadence FROM workouts WHERE id = ?',
    [id],
  )!;
}

describe('cadence and steps without Apple statistics', () => {
  it('ignores a few background steps of the phone during part of a run', () => {
    // a Runkeeper copy: no step statistic; the phone lay in a locker and counted 9 steps in 15 minutes
    const id = workout('run', 'Runkeeper', 60, [stat('DistanceWalkingRunning', 10_000)]);
    rec(STEPS, PHONE, T0 + 20 * 60, T0 + 35 * 60, 9);
    expect(derived(id)).toEqual({ step_count: null, avg_cadence: null });
  });

  it('counts step records that reach over the start or the end with their share inside the workout', () => {
    // 170 steps/min in 2-minute records, the first starting a minute before the run and the last ending a minute after
    const id = workout('run', 'Runkeeper', 60, [stat('DistanceWalkingRunning', 10_000)]);
    for (let t = T0 - 60; t < T0 + 3600; t += 120) rec(STEPS, PHONE, t, t + 120, 340);
    const w = derived(id);
    expect(w.step_count).toBe(10_200);
    expect(w.avg_cadence).toBeCloseTo(170, 0);
  });

  it('keeps a steady step cadence from records covering the whole run', () => {
    const id = workout('run', 'Runkeeper', 30, [stat('DistanceWalkingRunning', 5_000)]);
    for (let t = T0; t < T0 + 1800; t += 60) rec(STEPS, PHONE, t, t + 60, 172);
    const w = derived(id);
    expect(w.step_count).toBe(30 * 172);
    expect(w.avg_cadence).toBeCloseTo(172, 0);
  });

  it('leaves an implausible bike cadence out and keeps a real one', () => {
    const bad = workout('ride', 'Apple Watch', 30);
    for (let t = T0; t <= T0 + 1800; t += 5) rec(CYCLING_CADENCE, WATCH, t, t, 400);
    expect(derived(bad).avg_cadence).toBeNull();
    run(db, 'DELETE FROM records WHERE type_id = ?', [CYCLING_CADENCE]);
    for (let t = T0; t <= T0 + 1800; t += 5) rec(CYCLING_CADENCE, WATCH, t, t, 85);
    expect(derived(bad).avg_cadence).toBeCloseTo(85, 0);
  });
});

describe('workoutsStep', () => {
  it("does not touch another athlete's workout passed by id", async () => {
    run(db, "INSERT INTO athletes (id, name) VALUES (2, 'Other')");
    const own = workout('run', 'Runkeeper', 30, [stat('DistanceWalkingRunning', 5_000)]);
    const other = run(
      db,
      `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, duration_s, source_name)
       VALUES (2, 'other', 'HKWorkoutActivityTypeRunning', 'run', ?, ?, 1800, 'Runkeeper')`,
      [T0, T0 + 1800],
    ).lastInsertRowid;
    const noop = () => {};
    await workoutsStep.run({
      db,
      athleteId: 1,
      workoutIds: [own, other],
      sinceDay: null,
      report: noop,
      checkCancelled: noop,
      log: noop,
    });
    const version = (id: number) =>
      get<{ v: number }>(db, 'SELECT derived_version AS v FROM workouts WHERE id = ?', [id])!.v;
    expect(version(own)).toBeGreaterThan(0);
    expect(version(other)).toBe(0);
  });
});
