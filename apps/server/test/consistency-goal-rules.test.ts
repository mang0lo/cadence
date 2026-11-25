import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Goal, GoalsResponse } from '@cadence/shared';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { all, get, openDb, run, type Db } from '../src/db/db';
import { DERIVE_VERSION } from '../src/derive/context';
import { refreshDailyActivity } from '../src/derive/daily';
import { migrations } from '../src/features/consistency/migrations';
import { addDays } from '../src/lib/time';

/** Rules around goals: which sports a goal accepts, and where a check mark set by hand lands. */
let dir: string;
let db: Db;
let app: FastifyInstance;
const TODAY = '2026-06-24'; // a Wednesday; the rings reach 2026-06-20 (the data horizon)

let ext = 0;
function addRun(day: string, distanceM = 8_000): void {
  const start = Date.parse(`${day}T07:00:00+02:00`) / 1000;
  run(
    db,
    `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, distance_m, derived_version)
     VALUES (1, ?, 'HKWorkoutActivityTypeRunning', 'run', ?, ?, 120, 2700, ?, ?)`,
    [`k${ext++}`, start, start + 2700, distanceM, DERIVE_VERSION],
  );
}

const post = (payload: object) => app.inject({ method: 'POST', url: '/api/consistency/goals', payload });
const patch = (id: number, payload: object) => app.inject({ method: 'PATCH', url: `/api/consistency/goals/${id}`, payload });
const goals = async () => {
  const res = await app.inject({ url: `/api/consistency/goals?today=${TODAY}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<GoalsResponse>();
};
async function setWeekStart(weekStart: 0 | 1) {
  expect((await app.inject({ method: 'PATCH', url: '/api/settings', payload: { weekStart } })).statusCode).toBe(200);
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-goal-rules-'));
  const config = loadConfig({ CADENCE_DATA_DIR: path.join(dir, 'data'), CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
  db = openDb(config.dbPath);
  migrateAll(db);
  for (let i = 1; i <= 28; i += 3) addRun(`2026-05-${String(i).padStart(2, '0')}`);
  for (let day = '2026-05-01'; day <= '2026-06-20'; day = addDays(day, 1))
    run(db, 'INSERT INTO activity_summaries (athlete_id, day, active_energy_kcal, active_energy_goal_kcal) VALUES (1, ?, 500, 450)', [day]);
  refreshDailyActivity(db, 1);
  app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('goal validation', () => {
  it('rejects sports that are only inherited object keys', async () => {
    for (const sport of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
      expect((await post({ period: 'week', sport, metric: 'time', target: 3600 })).statusCode, sport).toBe(400);
    }
    const ok = await post({ period: 'week', sport: 'run', metric: 'time', target: 3600 });
    expect(ok.statusCode).toBe(201);
    const id = ok.json<Goal>().id;
    expect((await patch(id, { sport: 'toString' })).statusCode).toBe(400);
    expect((await patch(id, { sport: 'ride' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/consistency/goals/${id}` })).statusCode).toBe(200);
  });
});

describe('check marks of weekly goals', () => {
  it('stay on the week they were set for when the week start changes', async () => {
    await setWeekStart(0);
    const goal = (await post({ period: 'week', sport: null, metric: 'active_days', target: 7 })).json<Goal>();
    const check = await app.inject({
      method: 'PUT',
      url: `/api/consistency/goals/${goal.id}/check`,
      payload: { day: '2026-06-10', done: true, today: TODAY },
    });
    expect(check.json()).toMatchObject({ start: '2026-06-07', end: '2026-06-13', done: true });
    const manualWeeks = async () =>
      (await goals()).goals.find((g) => g.id === goal.id)!.history.filter((h) => h.manual).map((h) => h.start);
    expect(await manualWeeks()).toEqual(['2026-06-07']);
    await setWeekStart(1);
    expect(await manualWeeks()).toEqual(['2026-06-08']);
    // taking it back in Monday weeks removes it
    await app.inject({ method: 'PUT', url: `/api/consistency/goals/${goal.id}/check`, payload: { day: '2026-06-14', done: false, today: TODAY } });
    expect(await manualWeeks()).toEqual([]);
    await setWeekStart(0);
    expect(await manualWeeks()).toEqual([]);
  });

  it('moves the marks of weekly goals that an older version keyed by the first day of the week', () => {
    const goal = (period: string) =>
      Number(
        run(db, "INSERT INTO consistency_goals (athlete_id, period, sport, metric, target) VALUES (1, ?, NULL, 'active_days', 3)", [period])
          .lastInsertRowid,
      );
    const week = goal('week');
    const month = goal('month');
    // a Sunday (Sunday weeks), a Monday (Monday weeks) and a monthly mark that happens to be a Monday
    for (const [id, day] of [[week, '2026-06-07'], [week, '2026-06-15'], [month, '2026-06-01']] as const)
      run(db, 'INSERT INTO consistency_goal_checks (goal_id, day) VALUES (?, ?)', [id, day]);
    run(db, "INSERT OR REPLACE INTO settings (athlete_id, key, value) VALUES (1, 'consistency.goalsBackup', ?)", [
      JSON.stringify([
        { period: 'week', sport: null, metric: 'active_days', target: 3, checks: ['2026-06-07', '2026-06-15'] },
        { period: 'month', sport: null, metric: 'active_days', target: 3, checks: ['2026-06-01'] },
      ]),
    ]);
    const up = migrations.find((m) => m.id === 'consistency_003_week_checks_midweek')!.up;
    if (typeof up !== 'function') throw new Error('expected a JS migration');
    up(db);
    const days = (id: number) => all<{ day: string }>(db, 'SELECT day FROM consistency_goal_checks WHERE goal_id = ? ORDER BY day', [id]).map((r) => r.day);
    expect(days(week)).toEqual(['2026-06-10', '2026-06-18']);
    expect(days(month)).toEqual(['2026-06-01']);
    const backup = JSON.parse(get<{ value: string }>(db, "SELECT value FROM settings WHERE athlete_id = 1 AND key = 'consistency.goalsBackup'")!.value);
    expect(backup.map((g: { checks: string[] }) => g.checks)).toEqual([['2026-06-10', '2026-06-18'], ['2026-06-01']]);
  });
});

describe('starting goals', () => {
  // a fresh athlete whose first import is still running: workouts and rings are in, the daily totals are not yet
  let dir2: string;
  let db2: Db;
  let app2: FastifyInstance;
  const goalsOf = async () => {
    const res = await app2.inject({ url: '/api/consistency/goals?today=2026-06-24' });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<GoalsResponse>().goals.map((g) => `${g.period} ${g.sport ?? 'all'} ${g.metric} ${g.target}`);
  };

  beforeAll(async () => {
    dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-goal-seed-'));
    const config = loadConfig({ CADENCE_DATA_DIR: path.join(dir2, 'data'), CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
    db2 = openDb(config.dbPath);
    migrateAll(db2);
    // runs on five days of every week from 2026-04-06 on (45 min, 10 km), rings every day
    for (let day = '2026-04-06'; day <= '2026-06-21'; day = addDays(day, 1)) {
      const start = Date.parse(`${day}T07:00:00+02:00`) / 1000;
      if (new Date(`${day}T12:00:00Z`).getUTCDay() % 7 < 5)
        run(
          db2,
          `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, distance_m, derived_version)
           VALUES (1, ?, 'HKWorkoutActivityTypeRunning', 'run', ?, ?, 120, 2700, 10000, ?)`,
          [`s${day}`, start, start + 2700, DERIVE_VERSION],
        );
      run(db2, 'INSERT INTO activity_summaries (athlete_id, day, active_energy_kcal, active_energy_goal_kcal) VALUES (1, ?, 500, 450)', [day]);
    }
    app2 = await buildApp(config, db2, { jobRunner: 'inline' });
    await app2.ready();
    run(db2, "INSERT INTO import_jobs (id, athlete_id, kind, status, progress) VALUES ('first', 1, 'import', 'running', 0.8)");
  });

  afterAll(async () => {
    await app2?.close();
    db2?.close();
    fs.rmSync(dir2, { recursive: true, force: true });
  });

  it('are seeded from the daily totals once the import is done, not from the half-imported data', async () => {
    expect(await goalsOf()).toEqual([]);
    // the import finishes: its last core step writes the daily totals
    refreshDailyActivity(db2, 1);
    run(db2, "UPDATE import_jobs SET status = 'done', finished_at = unixepoch() WHERE id = 'first'");
    expect(await goalsOf()).toEqual(['week all active_days 5', 'week all time 14400', 'month run distance 200000']);
  });
});
