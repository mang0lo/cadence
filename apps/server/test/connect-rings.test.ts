import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { updateSettings } from '../src/core/settings';
import { all, get, openDb, run, type Db } from '../src/db/db';
import { reconcileCorosRings, storeCorosRings, syncCorosMobile } from '../src/features/connect/coros-health';
import type { MobileDay } from '../src/features/connect/coros-mobile';
import { closed } from '../src/features/consistency/achievements';
import { ringFractions, type RingRow } from '../src/features/consistency/data';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-rings-'));
  db = openDb(path.join(dir, 'cadence.db'));
  migrateAll(db);
  updateSettings(db, 1, { watch: 'coros' });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ymd = (day: string) => Number(day.replace(/-/g, ''));
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
/** COROS' share of the goal: whole percent, capped at 100. */
const share = (v: number, goal: number) => Math.min(100, Math.floor((v * 100) / goal));
/** One day of the COROS app's calendar (dataType 12) with goals of 600 kcal / 30 min unless given. */
const cal = (day: string, kcal: number, min: number, goalKcal = 600, goalMin = 30): MobileDay => ({
  happenDay: ymd(day),
  calendarData: {
    calorie: kcal * 1000,
    calorieStandardRate: share(kcal, goalKcal),
    motionTime: min * 60,
    motionTimeStandardRate: share(min, goalMin),
  },
});
const ring = (day: string) =>
  get<RingRow>(db, 'SELECT * FROM activity_summaries WHERE athlete_id = 1 AND day = ?', [day]);
const status = (day: string) => {
  const f = ringFractions(ring(day)!);
  return { move: closed(f.move), exercise: closed(f.exercise) };
};

describe('COROS rings: goals', () => {
  it('keeps low days open: their goal is never their own value', () => {
    storeCorosRings(db, 1, [
      cal('2026-06-01', 30, 1), // 5 % / 3 %: the share is too rough to give the goal
      cal('2026-06-02', 70, 2),
      cal('2026-06-03', 450, 15), // 75 % / 50 %: goals 600 / 30 exactly
      cal('2026-06-04', 60, 2),
    ]);
    for (const day of ['2026-06-01', '2026-06-02', '2026-06-04']) {
      expect(status(day), day).toEqual({ move: false, exercise: false });
      expect(ring(day), day).toMatchObject({ active_energy_goal_kcal: 600, exercise_goal_min: 30 });
    }
    expect(ring('2026-06-03')).toMatchObject({ active_energy_kcal: 450, active_energy_goal_kcal: 600, exercise_min: 15 });
  });

  it('estimates the goal from a rough share rather than closing the ring', () => {
    storeCorosRings(db, 1, [cal('2026-06-01', 30, 1), cal('2026-06-02', 50, 3)]);
    expect(status('2026-06-01')).toEqual({ move: false, exercise: false });
    expect(status('2026-06-02')).toEqual({ move: false, exercise: false });
    expect(ring('2026-06-01')!.active_energy_goal_kcal).toBe(600);
  });

  it('keeps closed days closed and takes the goal of a partly done day', () => {
    // the day the existing sync test uses: calories closed (100 %), 18 of 30 active minutes (60 %)
    storeCorosRings(db, 1, [
      {
        happenDay: 20260601,
        calendarData: { calorie: 450_000, calorieStandardRate: 100, motionTime: 1080, motionTimeStandardRate: 60 },
      },
    ]);
    expect(ring('2026-06-01')).toMatchObject({
      active_energy_kcal: 450,
      active_energy_goal_kcal: 450,
      exercise_min: 18,
      exercise_goal_min: 30,
    });
    expect(status('2026-06-01')).toEqual({ move: true, exercise: false });
  });

  it('stores no goal for a day without a share instead of its value', () => {
    storeCorosRings(db, 1, [{ happenDay: 20260601, calendarData: { calorie: 300_000, motionTime: 600 } }]);
    expect(ring('2026-06-01')).toMatchObject({ active_energy_goal_kcal: null, exercise_goal_min: null });
  });

  it('keeps rest days open when they leave the window of the daily syncs', async () => {
    // every third day a rest day (60 kcal = 10 %, 2 min = 6 %); a sync every day as the auto sync does
    const history = new Map<string, MobileDay>();
    for (let d = '2026-05-01', i = 0; d <= '2026-08-31'; d = addDays(d, 1), i++)
      history.set(d, i % 3 === 0 ? cal(d, 60, 2) : cal(d, 450 + ((i * 37) % 100), 15 + ((i * 7) % 10)));
    const daily = (today: string) => async (dataType: number, start: number, end: number) =>
      dataType !== 12
        ? []
        : [...history.values()].filter((d) => d.happenDay >= start && d.happenDay <= end && d.happenDay <= ymd(today));
    await syncCorosMobile(db, 1, daily('2026-06-01'), { sinceDay: null, today: '2026-06-01' });
    let last = '2026-06-01';
    for (let today = '2026-06-02'; today <= '2026-08-31'; today = addDays(today, 1)) {
      await syncCorosMobile(db, 1, daily(today), { sinceDay: addDays(last, -3), today });
      last = today;
    }
    const wrong = [...history.keys()].filter((day) => {
      const c = history.get(day)!.calendarData!;
      const s = status(day);
      return s.move !== (c.calorieStandardRate === 100) || s.exercise !== (c.motionTimeStandardRate === 100);
    });
    expect(wrong).toEqual([]);
    // rest days long out of the window keep the real goals (2026-06-03 is day 33 of the history)
    expect(ring('2026-06-03')).toMatchObject({ active_energy_kcal: 60, active_energy_goal_kcal: 600, exercise_goal_min: 30 });
  });
});

describe('COROS rings: sources', () => {
  const apple = (day: string) =>
    run(
      db,
      `INSERT INTO activity_summaries (athlete_id, day, active_energy_kcal, active_energy_goal_kcal, move_time_min,
         move_time_goal_min, exercise_min, exercise_goal_min, stand_hours, stand_goal_hours)
       VALUES (1, ?, 512.5, 500, NULL, NULL, 41, 30, 11, 12)`,
      [day],
    );

  it('updates its own rows when Apple is preferred (today keeps changing)', () => {
    updateSettings(db, 1, { watch: 'apple' });
    storeCorosRings(db, 1, [cal('2026-06-01', 150, 5)]); // the 9:00 sync
    storeCorosRings(db, 1, [cal('2026-06-01', 650, 35)]); // the 21:00 sync
    expect(ring('2026-06-01')).toMatchObject({ active_energy_kcal: 650, exercise_min: 35 });
    expect(status('2026-06-01')).toEqual({ move: true, exercise: true });
  });

  it('leaves Apple rings alone when Apple is preferred', () => {
    updateSettings(db, 1, { watch: 'apple' });
    apple('2026-06-01');
    storeCorosRings(db, 1, [cal('2026-06-01', 150, 5)]);
    expect(ring('2026-06-01')).toMatchObject({ active_energy_kcal: 512.5, stand_hours: 11 });
  });

  it('restores the Apple rings when Apple is preferred again', () => {
    apple('2026-06-01');
    const before = ring('2026-06-01');
    storeCorosRings(db, 1, [cal('2026-06-01', 150, 5)]);
    expect(ring('2026-06-01')).toMatchObject({ active_energy_kcal: 150, stand_hours: null });
    updateSettings(db, 1, { watch: 'apple' });
    reconcileCorosRings(db, 1);
    expect(ring('2026-06-01')).toEqual(before);
    // and the watch's again
    updateSettings(db, 1, { watch: 'coros' });
    reconcileCorosRings(db, 1);
    expect(ring('2026-06-01')).toMatchObject({ active_energy_kcal: 150, stand_hours: null });
  });

  it('wins again over rings a later Apple import wrote while the watch is preferred', () => {
    storeCorosRings(db, 1, [cal('2026-06-01', 150, 5)]);
    // an Apple export import overwrites the day (import/writer.ts upserts every column)
    run(
      db,
      `UPDATE activity_summaries SET active_energy_kcal = 512.5, active_energy_goal_kcal = 500, exercise_min = 41,
         exercise_goal_min = 30, stand_hours = 11, stand_goal_hours = 12 WHERE athlete_id = 1 AND day = '2026-06-01'`,
    );
    reconcileCorosRings(db, 1);
    expect(ring('2026-06-01')).toMatchObject({ active_energy_kcal: 150, stand_hours: null });
    updateSettings(db, 1, { watch: 'apple' });
    reconcileCorosRings(db, 1);
    expect(ring('2026-06-01')).toMatchObject({ active_energy_kcal: 512.5, stand_hours: 11 });
  });

  it('takes over ring rows an earlier version stored for COROS', () => {
    updateSettings(db, 1, { watch: 'apple' });
    // v1.0.0 wrote COROS rows straight into activity_summaries (no stand ring, whole numbers)
    run(
      db,
      `INSERT INTO activity_summaries (athlete_id, day, active_energy_kcal, active_energy_goal_kcal, exercise_min, exercise_goal_min)
       VALUES (1, '2026-06-01', 150, 150, 5, 5)`,
    );
    storeCorosRings(db, 1, [cal('2026-06-01', 650, 35)]);
    expect(ring('2026-06-01')).toMatchObject({ active_energy_kcal: 650, exercise_min: 35 });
    expect(all(db, 'SELECT day, replaced FROM connect_rings')).toEqual([{ day: '2026-06-01', replaced: null }]);
  });

  it('never writes back rings a COROS sync replaced while the import worker reconciled', () => {
    storeCorosRings(db, 1, [cal('2026-06-01', 150, 5)]);
    // an Apple export import rewrote the day
    run(
      db,
      `UPDATE activity_summaries SET active_energy_kcal = 512.5, active_energy_goal_kcal = 500, exercise_min = 41,
         exercise_goal_min = 30, stand_hours = 11, stand_goal_hours = 12 WHERE athlete_id = 1 AND day = '2026-06-01'`,
    );
    // the import worker reconciles (db) while the sync on the main thread (another connection) stores new values
    const main = openDb(path.join(dir, 'cadence.db'));
    main.exec('PRAGMA busy_timeout = 0');
    const syncStore = () => storeCorosRings(main, 1, [cal('2026-06-01', 300, 10)]);
    let waited = false;
    const prepareOf = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const st = prepareOf(sql);
      if (!sql.includes('FROM connect_rings c LEFT JOIN activity_summaries')) return st;
      const read = st.all.bind(st) as unknown as (...params: unknown[]) => unknown[];
      // right after the worker read the rings, the sync tries to store (it waits for the worker's transaction)
      st.all = ((...params: unknown[]) => {
        const rows = read(...params);
        try {
          syncStore();
        } catch {
          waited = true;
        }
        return rows;
      }) as unknown as typeof st.all;
      return st;
    };
    reconcileCorosRings(db, 1);
    if (waited) syncStore();
    main.close();
    expect(ring('2026-06-01')).toMatchObject({
      active_energy_kcal: 300,
      exercise_min: 10,
      stand_hours: null,
    });
    // preferring Apple again brings back Apple's rings, not an older COROS copy
    updateSettings(db, 1, { watch: 'apple' });
    reconcileCorosRings(db, 1);
    expect(ring('2026-06-01')).toMatchObject({ active_energy_kcal: 512.5, stand_hours: 11 });
  });
});
