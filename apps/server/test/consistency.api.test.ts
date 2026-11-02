import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CalendarResponse,
  ConsistencyOverview,
  DayDetail,
  Goal,
  GoalsResponse,
  PunchcardResponse,
  StreakSummary,
  TrophiesResponse,
  YearReview,
} from '@cadence/shared';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { get, openDb, run, type Db } from '../src/db/db';
import { refreshDailyActivity } from '../src/derive/daily';
import type { DeriveContext } from '../src/features/types';
import { achievementsStep } from '../src/features/consistency/trophies';
import { resetAthleteData } from '../src/import/reset';

let dir: string;
let db: Db;
let app: FastifyInstance;
const TODAY = '2026-06-03'; // a Wednesday

let ext = 0;
function addWorkout(day: string, hour: number, sport: string, o: { distanceM?: number; elevationM?: number; durationS?: number; hidden?: boolean } = {}) {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const tzMin = 120;
  const start = Date.UTC(y, m - 1, d, hour) / 1000 - tzMin * 60;
  const duration = o.durationS ?? 3600;
  run(
    db,
    `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, distance_m, elevation_gain_m, hidden)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`k${ext++}`, `HKWorkoutActivityType${sport}`, sport, start, start + duration, tzMin, duration, o.distanceM ?? null, o.elevationM ?? null, o.hidden ? 1 : 0],
  );
}

function addRings(day: string, exerciseMin: number) {
  run(
    db,
    `INSERT INTO activity_summaries (athlete_id, day, active_energy_kcal, active_energy_goal_kcal, move_time_min, move_time_goal_min,
       exercise_min, exercise_goal_min, stand_hours, stand_goal_hours) VALUES (1, ?, 700, 600, 0, 0, ?, 30, 12, 12)`,
    [day, exerciseMin],
  );
}

const ctx = (): DeriveContext => ({
  db,
  athleteId: 1,
  workoutIds: 'all',
  sinceDay: null,
  report: () => {},
  checkCancelled: () => {},
  log: () => {},
});

async function getJson<T>(url: string): Promise<T> {
  const res = await app.inject({ url });
  expect(res.statusCode, `${url}: ${res.body.slice(0, 300)}`).toBe(200);
  return res.json<T>();
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-consistency-'));
  const config = loadConfig({ CADENCE_DATA_DIR: path.join(dir, 'data'), CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
  db = openDb(config.dbPath);
  migrateAll(db);
  // 2025: one run; 2026: a ride on 10 May, runs every day 24 May – 2 Jun, a hidden workout today
  addWorkout('2025-06-01', 9, 'run', { distanceM: 10_000 });
  addWorkout('2026-05-10', 6, 'ride', { distanceM: 50_000, elevationM: 600 });
  for (let i = 0; i < 10; i++) {
    const day = new Date(Date.UTC(2026, 4, 24 + i)).toISOString().slice(0, 10);
    addWorkout(day, 7, 'run', { distanceM: 8_000, elevationM: 40 });
  }
  addWorkout(TODAY, 7, 'run', { distanceM: 5_000, hidden: true });
  for (let i = 0; i < 8; i++) {
    const day = new Date(Date.UTC(2026, 4, 27 + i)).toISOString().slice(0, 10);
    addRings(day, day === '2026-05-31' ? 10 : 45);
  }
  run(
    db,
    `INSERT INTO daily_metrics (athlete_id, metric, day, value, n) VALUES
       (1, 'HKQuantityTypeIdentifierStepCount', '2026-05-31', 12345, 10),
       (1, 'HKQuantityTypeIdentifierRestingHeartRate', '2026-05-31', 50, 1)`,
  );
  refreshDailyActivity(db, 1);
  app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('consistency API', () => {
  it('reports streaks as of the data horizon', async () => {
    const s = await getJson<StreakSummary>(`/api/consistency/streaks?today=${TODAY}`);
    expect(s.asOf).toBe(TODAY);
    expect(s.daily).toMatchObject({ current: 10, currentStart: '2026-05-24', pending: true });
    expect(s.weekly).toMatchObject({ current: 3, pending: false, thisWeek: 2 });
    expect(s.rings!.move.current).toBe(8);
    expect(s.rings!.exercise).toMatchObject({ current: 3, longest: 4 });
    expect(s.recent).toHaveLength(14);
    expect(s.recent[13]).toEqual({ day: TODAY, active: false });
    // a later "today" without new data keeps judging as of the last data day
    expect((await getJson<StreakSummary>('/api/consistency/streaks?today=2026-06-20')).asOf).toBe(TODAY);
  });

  it('returns the overview with active days and the score', async () => {
    const o = await getJson<ConsistencyOverview>(`/api/consistency/overview?today=${TODAY}`);
    expect(o.years).toEqual([2025, 2026]);
    expect(o.firstDay).toBe('2025-06-01');
    expect(o.activeDays).toEqual({ year: 2026, thisYear: 11, lastYearToDate: 1, thisMonth: 2, last30: 11 });
    expect(o.score).toMatchObject({ basis: 'days', total: 12, met: 1 });
    expect(o.prefs).toEqual({ scoreBasis: 'days', minActiveDays: 3 });
  });

  it('serves the calendar, day details and the punchcard', async () => {
    const cal = await getJson<CalendarResponse>(`/api/consistency/calendar?year=2026&today=${TODAY}`);
    expect(cal.days).toHaveLength(12);
    expect(cal.days[0]).toMatchObject({ day: '2026-05-10', count: 1, distanceM: 50_000, elevationM: 600, sports: ['ride'] });
    const last = cal.days[cal.days.length - 1]!;
    expect(last).toMatchObject({ day: TODAY, count: 0, exercise: 1.5 });
    expect(last.move).toBeCloseTo(700 / 600);
    const range = await getJson<CalendarResponse>('/api/consistency/calendar?from=2026-05-01&to=2026-05-24');
    expect(range.days.map((d) => d.day)).toEqual(['2026-05-10', '2026-05-24']);
    expect((await app.inject({ url: '/api/consistency/calendar?from=2026-06-03&to=2026-06-01' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/consistency/calendar' })).statusCode).toBe(400);

    const day = await getJson<DayDetail>('/api/consistency/day/2026-05-31');
    expect(day.workouts).toHaveLength(1);
    expect(day.workouts[0]!.sport).toBe('run');
    expect(day.health).toMatchObject({ steps: 12345, restingHr: 50, sleepMin: null });
    expect(day.rings!.exercise).toBeCloseTo(1 / 3);
    expect((await getJson<DayDetail>(`/api/consistency/day/${TODAY}`)).workouts).toHaveLength(0); // hidden
    expect((await app.inject({ url: '/api/consistency/day/2026-02-30' })).statusCode).toBe(400);

    const pc = await getJson<PunchcardResponse>('/api/consistency/punchcard?year=2026');
    expect(pc.total).toBe(11);
    expect(pc.cells.find((c) => c.hour === 7)!.count).toBeGreaterThan(0);
    expect((await getJson<PunchcardResponse>('/api/consistency/punchcard?year=all')).total).toBe(12);
  });

  it('stores score preferences', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/consistency/prefs', payload: { minActiveDays: 1 } });
    expect(res.json()).toEqual({ scoreBasis: 'days', minActiveDays: 1 });
    // active weeks among the last 12: 4–10 May (ride on Sunday 10th), 18–24 May, 25–31 May
    expect((await getJson<ConsistencyOverview>(`/api/consistency/overview?today=${TODAY}`)).score.met).toBe(3);
    expect((await app.inject({ method: 'PUT', url: '/api/consistency/prefs', payload: { minActiveDays: 0 } })).statusCode).toBe(400);
    await app.inject({ method: 'PUT', url: '/api/consistency/prefs', payload: { minActiveDays: 3 } });
  });

  let created: Goal;
  it('seeds default goals and supports CRUD', async () => {
    const first = await getJson<GoalsResponse>(`/api/consistency/goals?today=${TODAY}`);
    expect(first.goals.length).toBeGreaterThanOrEqual(2);
    expect(first.goals[0]).toMatchObject({ period: 'week', metric: 'active_days', sport: null });
    const week = first.goals[0]!;
    expect(week.current).toMatchObject({ start: '2026-06-01', end: '2026-06-07', value: 2, elapsedDays: 2 });
    expect(week.history.length).toBeGreaterThan(0);

    const bad = await app.inject({ method: 'POST', url: '/api/consistency/goals', payload: { period: 'week', sport: null, metric: 'active_days', target: 9 } });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/consistency/goals', payload: { period: 'week', sport: 'nope', metric: 'distance', target: 5 } })).statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url: '/api/consistency/goals', payload: { period: 'month', sport: 'run', metric: 'distance', target: 100_000 } });
    expect(res.statusCode).toBe(201);
    created = res.json<Goal>();
    expect(created).toMatchObject({ period: 'month', sport: 'run', metric: 'distance', target: 100_000 });

    const patched = await app.inject({ method: 'PATCH', url: `/api/consistency/goals/${created.id}`, payload: { target: 120_000 } });
    expect(patched.json<Goal>().target).toBe(120_000);
    const infeasible = await app.inject({ method: 'PATCH', url: `/api/consistency/goals/${created.id}`, payload: { metric: 'active_days', target: 40 } });
    expect(infeasible.statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/consistency/goals/9999', payload: { target: 1 } })).statusCode).toBe(404);

    const after = await getJson<GoalsResponse>(`/api/consistency/goals?today=${TODAY}`);
    const g = after.goals.find((x) => x.id === created.id)!;
    // June 1–2: 2 runs × 8 km
    expect(g.current).toMatchObject({ value: 16_000, target: 120_000, totalDays: 30, status: 'on_track' });
    expect(after.goals.length).toBe(first.goals.length + 1);
  });

  it('awards trophies and flags new ones after the next derive run', async () => {
    const t = await getJson<TrophiesResponse>(`/api/consistency/trophies?today=${TODAY}`);
    const byKey = new Map(t.achievements.map((a) => [a.key, a]));
    expect(byKey.get('activities.1')).toMatchObject({ earned: true, earnedDay: '2025-06-01', isNew: false });
    expect(byKey.get('activities.10')).toMatchObject({ earned: true, earnedDay: '2026-05-31' });
    expect(byKey.get('activities.10')!.workout).toMatchObject({ sport: 'run' });
    expect(byKey.get('daily_streak.7')).toMatchObject({ earned: true, earnedDay: '2026-05-30', progress: 10 });
    expect(byKey.get('move_streak.7')).toMatchObject({ earned: true, earnedDay: '2026-06-02' });
    expect(byKey.get('variety.3')!.earned).toBe(false);
    expect(t.summary.earned).toBe(t.achievements.filter((a) => a.earned).length);
    expect(t.challenges.current).toMatchObject({ month: '2026-06', daysLeft: 28, totalDays: 30 });
    expect(t.challenges.history[0]!.month).toBe('2026-05');
    const may = new Map(t.challenges.history[0]!.items.map((i) => [i.key, i]));
    expect(may.get('run50')).toMatchObject({ value: 64_000, completedDay: '2026-05-30' });

    addWorkout(TODAY, 18, 'swim', { distanceM: 1500 });
    refreshDailyActivity(db, 1);
    await achievementsStep.run(ctx());
    const t2 = await getJson<TrophiesResponse>(`/api/consistency/trophies?today=${TODAY}`);
    const v = t2.achievements.find((a) => a.key === 'variety.3')!;
    expect(v).toMatchObject({ earned: true, earnedDay: TODAY, isNew: true });
    expect(t2.achievements.find((a) => a.key === 'activities.1')!.isNew).toBe(false);
  });

  it('builds the year in review', async () => {
    const y = await getJson<YearReview>(`/api/consistency/year/2026?today=${TODAY}`);
    expect(y).toMatchObject({ year: 2026, complete: false, years: [2025, 2026] });
    expect(y.totals).toMatchObject({ activities: 12, activeDays: 12 });
    expect(y.previous).toMatchObject({ activities: 1 });
    expect(y.bySport.map((s) => s.sport)).toEqual(['run', 'ride', 'swim']);
    expect(y.months).toHaveLength(12);
    expect(y.topMonth!.month).toBe('2026-05');
    expect(y.longest).toMatchObject({ sport: 'ride', distanceM: 50_000 });
    expect(y.weekdays.reduce((a, b) => a + b, 0)).toBe(12);
    expect(y.hours[7]).toBe(10);
    expect(y.streaks.daily).toMatchObject({ start: '2026-05-24', end: '2026-06-03', length: 11 });
    expect(y.rings).toMatchObject({ days: 8, move: 8, exercise: 7 });
    expect(y.trophies.length).toBeGreaterThan(0);
    expect(y.trophies.every((a) => a.earnedDay!.startsWith('2026'))).toBe(true);
    expect((await getJson<YearReview>(`/api/consistency/year?today=${TODAY}`)).year).toBe(2026);
    expect((await app.inject({ url: '/api/consistency/year/1900' })).statusCode).toBe(400);
  });

  it('deletes goals and restores them after a data reset', async () => {
    expect((await app.inject({ method: 'DELETE', url: `/api/consistency/goals/${created.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/consistency/goals/${created.id}` })).statusCode).toBe(404);
    const before = (await getJson<GoalsResponse>(`/api/consistency/goals?today=${TODAY}`)).goals;
    resetAthleteData(db, 1);
    // consistency_goals is declared in Feature.keepOnReset, so the rows survive the reset itself
    expect(get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM consistency_goals')!.n).toBe(before.length);
    const after = (await getJson<GoalsResponse>(`/api/consistency/goals?today=${TODAY}`)).goals;
    expect(after.map((g) => [g.period, g.metric, g.sport, g.target])).toEqual(before.map((g) => [g.period, g.metric, g.sport, g.target]));
    expect(after[0]!.current.value).toBe(0);
  });
});
