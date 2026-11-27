import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PROGRESS_POWER_DURATIONS,
  type ProgressFtpResponse,
  type ProgressPowerCurve,
  type ProgressPowerCurveResponse,
  type WorkoutStreams,
} from '@cadence/shared';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { all, get, openDb, run, type Db } from '../src/db/db';
import type { DeriveContext } from '../src/features/types';
import { workoutCachesStep } from '../src/features/progress/derive';
import { ensurePowerBests, POWER_CURVE_VERSION, powerWorkoutsToRefresh } from '../src/features/progress/power-curve';
import {
  bestAverages,
  criticalPowerFit,
  medianStep,
  powerParts,
  powerPeriodRange,
  previousPowerRange,
} from '../src/features/progress/power-math';
import { gzipJson } from '../src/lib/gzip';
import { addDays, parseDay } from '../src/lib/time';

/** Stream with one sample every `step` seconds from 0 to `seconds` (inclusive). */
function stream(
  watts: (t: number) => number | null,
  seconds: number,
  step = 1,
  extra: Partial<WorkoutStreams> = {},
): WorkoutStreams {
  const t: number[] = [];
  const power: (number | null)[] = [];
  for (let s = 0; s <= seconds + 1e-9; s += step) {
    t.push(Math.round(s * 10) / 10);
    power.push(watts(s));
  }
  return { t, power, moving: t.map(() => 1), ...extra };
}

const at = (curve: { durationS: number; watts: number }[], d: number) =>
  curve.find((p) => p.durationS === d)?.watts;

describe('power resampling (1 Hz, gaps, breaks)', () => {
  it('keeps a 1 Hz stream as it is', () => {
    const parts = powerParts(stream(() => 200, 599));
    expect(parts).toHaveLength(1);
    expect(parts[0]!.watts).toHaveLength(600);
    expect(parts[0]!.measured).toBe(600);
    expect(parts[0]!.watts.every((w) => w === 200)).toBe(true);
  });

  it('interpolates short gaps and counts longer gaps as 0 W', () => {
    // samples 0…10 and 13…20 (3 s gap, interpolated), then nothing until 81 (60 s gap = 0 W)
    const st: WorkoutStreams = { t: [], power: [] };
    for (let s = 0; s <= 10; s++) (st.t.push(s), st.power!.push(100));
    for (let s = 13; s <= 20; s++) (st.t.push(s), st.power!.push(160));
    for (let s = 81; s <= 100; s++) (st.t.push(s), st.power!.push(300));
    const [p] = powerParts(st);
    expect(p!.watts[11]).toBeCloseTo(120, 9);
    expect(p!.watts[12]).toBeCloseTo(140, 9);
    expect(p!.watts[20]).toBe(160);
    expect(p!.watts[21]).toBe(0);
    expect(p!.watts[50]).toBe(0);
    expect(p!.watts[80]).toBe(0);
    expect(p!.watts[81]).toBe(300);
    expect(p!.measured).toBe(101 - 60);
  });

  it('treats missing and implausible samples as 0 W', () => {
    const [p] = powerParts(stream((t) => (t >= 10 && t < 20 ? null : t === 30 ? 5000 : 250), 59));
    expect(p!.watts[9]).toBe(250);
    expect(p!.watts[10]).toBe(0);
    expect(p!.watts[19]).toBe(0);
    expect(p!.watts[30]).toBe(0);
    expect(p!.watts[31]).toBe(250);
  });

  it('interpolates the 5 s / 10 s grid of workouts without GPS', () => {
    const five = powerParts(stream((t) => 200 + t, 600, 5));
    expect(medianStep(stream(() => 1, 600, 5).t, [[0, 121]])).toBe(5);
    expect(five[0]!.measured).toBe(601);
    expect(five[0]!.watts[7]).toBeCloseTo(207, 9);
    const ten = powerParts(stream(() => 180, 7200, 10));
    expect(ten[0]!.measured).toBe(7201);
  });

  it('starts a new part at every break and never fills across it', () => {
    const st = stream(() => 300, 1199, 1, { breaks: [600] });
    const parts = powerParts(st);
    expect(parts.map((p) => [p.startT, p.watts.length])).toEqual([
      [0, 600],
      [600, 600],
    ]);
  });

  it('returns nothing without power', () => {
    expect(powerParts({ t: [0, 1, 2] })).toEqual([]);
    expect(powerParts(stream(() => null, 100))).toEqual([]);
  });
});

describe('best average power per duration', () => {
  it('finds the best window and where it starts', () => {
    const parts = powerParts(stream((t) => (t >= 100 && t < 105 ? 1000 : 200), 1799));
    const b = bestAverages(parts, PROGRESS_POWER_DURATIONS);
    expect(at(b, 1)).toBe(1000);
    expect(at(b, 5)).toBe(1000);
    expect(b.find((x) => x.durationS === 5)!.offsetS).toBe(100);
    expect(at(b, 10)).toBe(600);
    expect(at(b, 1800)).toBeCloseTo((5 * 1000 + 1795 * 200) / 1800, 9);
    // only durations the workout covers
    expect(b.map((x) => x.durationS)).toEqual(PROGRESS_POWER_DURATIONS.filter((d) => d <= 1800));
  });

  it('never lets a window span a break, even without a time gap', () => {
    const flat = (breaks?: number[]) =>
      bestAverages(powerParts(stream(() => 300, 1199, 1, { breaks })), PROGRESS_POWER_DURATIONS);
    expect(at(flat(), 1200)).toBe(300);
    const split = flat([600]);
    expect(at(split, 600)).toBe(300);
    expect(at(split, 720)).toBeUndefined();
    expect(at(split, 1200)).toBeUndefined();
  });

  it('counts a pause without samples as 0 W (never overestimates)', () => {
    // 10 min at 300 W, 60 s without samples, 10 min at 300 W
    const b = bestAverages(
      powerParts(stream((t) => (t >= 600 && t < 660 ? null : 300), 1259)),
      PROGRESS_POWER_DURATIONS,
    );
    const gappy: WorkoutStreams = stream(() => 300, 1259);
    const keep = gappy.t.map((t) => t < 600 || t >= 660);
    const st: WorkoutStreams = {
      t: gappy.t.filter((_, i) => keep[i]),
      power: gappy.power!.filter((_, i) => keep[i]),
    };
    const g = bestAverages(powerParts(st), PROGRESS_POWER_DURATIONS);
    for (const x of [b, g]) {
      expect(at(x, 600)).toBe(300);
      expect(at(x, 1200)).toBeCloseTo((1140 * 300) / 1200, 9); // 285 W: the 60 zero seconds are always inside
    }
  });

  it('keeps the better of several parts', () => {
    const st = stream((t) => (t < 600 ? 200 : 260), 1199, 1, { breaks: [600] });
    const b = bestAverages(powerParts(st), PROGRESS_POWER_DURATIONS);
    expect(at(b, 300)).toBe(260);
    expect(b.find((x) => x.durationS === 300)!.offsetS).toBe(600);
  });

  it('is fast enough for thousands of workouts', () => {
    const st = stream((t) => 200 + 80 * Math.sin(t / 37) + (t % 600 < 20 ? 400 : 0), 5 * 3600);
    const t0 = performance.now();
    const b = bestAverages(powerParts(st), PROGRESS_POWER_DURATIONS);
    const ms = performance.now() - t0;
    expect(b.at(-1)!.durationS).toBe(18000);
    expect(ms).toBeLessThan(250); // a 5 h ride at 1 Hz, all durations (typically a few ms)
  });
});

describe('critical power', () => {
  const model = (cp: number, w: number, ds = [180, 240, 300, 360, 480, 600, 720, 900, 1200]) =>
    ds.map((d) => ({ durationS: d, watts: cp + w / d }));

  it('recovers CP and W′ from bests on the model curve', () => {
    const r = criticalPowerFit([
      { durationS: 60, watts: 600 },
      ...model(250, 20_000),
      { durationS: 3600, watts: 230 },
    ]);
    expect(r.issue).toBeNull();
    expect(r.fit!.cpW).toBeCloseTo(250, 6);
    expect(r.fit!.wPrimeJ).toBeCloseTo(20_000, 3);
    expect(r.fit!.r2).toBeCloseTo(1, 9);
    expect(r.fit!.durations).toEqual([180, 240, 300, 360, 480, 600, 720, 900, 1200]);
  });

  it('needs enough bests between 3 and 20 minutes', () => {
    expect(criticalPowerFit(model(250, 20_000, [180, 300])).issue).toBe('tooFew');
    expect(criticalPowerFit(model(250, 20_000, [600, 900, 1200])).issue).toBe('tooFew');
    expect(criticalPowerFit(model(250, 20_000, [180, 240, 300])).issue).toBe('tooFew');
    expect(criticalPowerFit(model(250, 20_000, [180, 600, 900])).issue).toBeNull();
  });

  it('rejects bests that do not fit the model', () => {
    // a flat curve (no hard short efforts): W′ ≈ 0
    expect(criticalPowerFit(model(250, 0)).issue).toBe('poorFit');
    // inconsistent bests
    const bad = [
      { durationS: 180, watts: 420 },
      { durationS: 300, watts: 250 },
      { durationS: 600, watts: 330 },
      { durationS: 1200, watts: 240 },
    ];
    expect(criticalPowerFit(bad).issue).toBe('poorFit');
  });
});

describe('power-curve periods', () => {
  const today = '2026-11-03';
  const span = { firstDay: '2024-03-10', lastDay: '2026-11-01' };

  it('resolves the presets', () => {
    expect(powerPeriodRange('42d', today, { span })).toEqual({ fromDay: '2026-09-23', toDay: today });
    expect(powerPeriodRange('90d', today, { span })).toEqual({ fromDay: '2026-08-06', toDay: today });
    expect(powerPeriodRange('12m', today, { span })).toEqual({ fromDay: '2025-11-04', toDay: today });
    expect(powerPeriodRange('year', today, { span, year: 2025 })).toEqual({
      fromDay: '2025-01-01',
      toDay: '2025-12-31',
    });
    expect(powerPeriodRange('year', today, { span })).toEqual({ fromDay: '2026-01-01', toDay: '2026-12-31' });
    expect(powerPeriodRange('all', today, { span })).toEqual({ fromDay: '2024-03-10', toDay: today });
    expect(powerPeriodRange('all', today, { span: { firstDay: null, lastDay: null } })).toEqual({
      fromDay: today,
      toDay: today,
    });
    expect(powerPeriodRange('custom', today, { span, fromDay: '2026-05-01', toDay: '2026-05-31' })).toEqual({
      fromDay: '2026-05-01',
      toDay: '2026-05-31',
    });
  });

  it('the previous period has the same length', () => {
    const r42 = powerPeriodRange('42d', today, { span });
    expect(previousPowerRange('42d', r42)).toEqual({ fromDay: '2026-08-12', toDay: '2026-09-22' });
    expect(previousPowerRange('12m', powerPeriodRange('12m', today, { span }))).toEqual({
      fromDay: '2024-11-04',
      toDay: '2025-11-03',
    });
    expect(previousPowerRange('year', { fromDay: '2025-01-01', toDay: '2025-12-31' })).toEqual({
      fromDay: '2024-01-01',
      toDay: '2024-12-31',
    });
    const custom = previousPowerRange('custom', { fromDay: '2026-05-01', toDay: '2026-05-31' })!;
    expect(custom).toEqual({ fromDay: '2026-03-31', toDay: '2026-04-30' });
    expect(parseDay(custom.toDay)! - parseDay(custom.fromDay)!).toBe(30);
    expect(previousPowerRange('all', r42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Derive step + API on hand-made workouts (exact expectations)
// ---------------------------------------------------------------------------

describe('power curve API', () => {
  const TODAY = '2026-11-03';
  const noon = (day: string) => parseDay(day)! * 86400 + 11 * 3600; // 12:00 local at UTC+60
  let dir: string;
  let db: Db;
  let app: FastifyInstance;
  const ids: Record<string, number> = {};

  const getJson = async <T>(url: string): Promise<T> => {
    const res = await app.inject({ url });
    expect(res.statusCode, `${url}: ${res.body.slice(0, 300)}`).toBe(200);
    return res.json<T>();
  };
  const status = async (url: string) => (await app.inject({ url })).statusCode;

  function insertPowerWorkout(o: {
    sport: string;
    day: string;
    st: WorkoutStreams;
    hidden?: boolean;
    duplicateOf?: number;
    name?: string;
  }): number {
    const start = noon(o.day);
    const end = start + Math.round(o.st.t.at(-1)!);
    const valid = (o.st.power ?? []).filter((p): p is number => p !== null);
    const r = run(
      db,
      `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, name, start_ts, end_ts, tz_min, duration_s,
         avg_power, max_power, hidden, duplicate_of, updated_at)
       VALUES (1, ?, 'HKWorkoutActivityTypeCycling', ?, ?, ?, ?, 60, ?, ?, ?, ?, ?, 1000)`,
      [
        `test|${o.sport}|${start}|${Math.random()}`,
        o.sport,
        o.name ?? '',
        start,
        end,
        end - start,
        valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null,
        valid.length ? Math.max(...valid) : null,
        o.hidden ? 1 : 0,
        o.duplicateOf ?? null,
      ],
    );
    run(db, 'INSERT INTO workout_streams (workout_id, version, points, data) VALUES (?, 1, ?, ?)', [
      r.lastInsertRowid,
      o.st.t.length,
      gzipJson(o.st),
    ]);
    return r.lastInsertRowid;
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

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-power-'));
    const config = loadConfig({
      CADENCE_DATA_DIR: path.join(dir, 'data'),
      CADENCE_MODE: 'dev',
      LOG_LEVEL: 'silent',
    });
    db = openDb(config.dbPath);
    migrateAll(db);
    app = await buildApp(config, db, { jobRunner: 'inline' });
    await app.ready();

    // A: 30 min at 250 W with a 10 s sprint at 900 W, 10 days ago
    ids.a = insertPowerWorkout({
      sport: 'ride',
      day: addDays(TODAY, -10),
      name: 'Sprint ride',
      st: stream((t) => (t >= 300 && t < 310 ? 900 : 250), 1799),
    });
    // B: 20 min at 280 W, 60 days ago (outside 42, inside 90 days)
    ids.b = insertPowerWorkout({
      sport: 'ride',
      day: addDays(TODAY, -60),
      name: 'Threshold',
      st: stream(() => 280, 1199),
    });
    // F: 60 min at 230 W, 200 days ago — with a track break after 30 minutes
    ids.f = insertPowerWorkout({
      sport: 'ride',
      day: addDays(TODAY, -200),
      st: stream(() => 230, 3599, 1, { breaks: [1800] }),
    });
    // hidden and duplicate rides with huge numbers must never show up
    ids.hidden = insertPowerWorkout({
      sport: 'ride',
      day: addDays(TODAY, -5),
      st: stream(() => 400, 1199),
      hidden: true,
    });
    ids.dup = insertPowerWorkout({
      sport: 'ride',
      day: addDays(TODAY, -10),
      st: stream(() => 500, 1199),
      duplicateOf: ids.a,
    });
    // a run with Apple Watch running power on a 5 s grid
    ids.run = insertPowerWorkout({ sport: 'run', day: addDays(TODAY, -3), st: stream(() => 300, 1500, 5) });
    // a ride without power
    ids.none = insertPowerWorkout({
      sport: 'ride',
      day: addDays(TODAY, -2),
      st: { t: [0, 600], power: [null, null] },
    });
    // body mass: 70 kg long ago, 72 kg 20 days ago
    run(
      db,
      `INSERT INTO daily_metrics (athlete_id, metric, day, value) VALUES (1, 'HKQuantityTypeIdentifierBodyMass', ?, 70), (1, 'HKQuantityTypeIdentifierBodyMass', ?, 72)`,
      [addDays(TODAY, -300), addDays(TODAY, -20)],
    );
    await workoutCachesStep.run(ctx());
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    db?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the derive step stores the bests of every workout with power', () => {
    const rows = all<{ workout_id: number; n: number; max_d: number }>(
      db,
      'SELECT workout_id, COUNT(*) AS n, MAX(duration_s) AS max_d FROM progress_power_bests GROUP BY workout_id',
    );
    const by = new Map(rows.map((r) => [r.workout_id, r]));
    expect(by.get(ids.a!)!.max_d).toBe(1800);
    expect(by.get(ids.f!)!.max_d).toBe(1800); // the 60-minute ride is split by its break
    expect(by.get(ids.hidden!)).toBeDefined(); // stored, excluded at query time
    expect(by.get(ids.none!)).toBeUndefined();
    const state = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM progress_power_state WHERE version = ?', [
      POWER_CURVE_VERSION,
    ])!;
    expect(state.n).toBe(Object.keys(ids).length);
    expect(powerWorkoutsToRefresh(db, 1, 'all')).toEqual([]);
    run(db, 'UPDATE workouts SET updated_at = updated_at + 1 WHERE id = ?', [ids.b!]);
    expect(powerWorkoutsToRefresh(db, 1, 'all').map((w) => w.id)).toEqual([ids.b]);
    run(db, 'UPDATE workouts SET updated_at = updated_at - 1 WHERE id = ?', [ids.b!]);
  });

  it('answers the curve of a period with the efforts that set it', async () => {
    const r = await getJson<ProgressPowerCurveResponse>(
      `/api/progress/power/curve?period=42d&compare=allTime&today=${TODAY}`,
    );
    expect(r.sport).toBe('ride');
    expect(r.sports).toEqual([
      { sport: 'ride', workouts: 3 },
      { sport: 'run', workouts: 1 },
    ]);
    expect(r.years).toEqual([2026]);
    expect(r.current).toMatchObject({ fromDay: addDays(TODAY, -41), toDay: TODAY, workouts: 1 });
    expect(r.current.bodyMass).toEqual({ kg: 72, day: addDays(TODAY, -20) });
    const p20 = r.current.points.find((p) => p.durationS === 1200)!;
    expect(p20.watts).toBeCloseTo(250 + (10 * 650) / 1200, 1);
    expect(p20).toMatchObject({ workoutId: ids.a, name: 'Sprint ride', sport: 'ride', tzMin: 60 });
    expect(p20.wkg).toBeCloseTo(p20.watts / 72, 2);
    expect(r.current.points.find((p) => p.durationS === 5)).toMatchObject({ watts: 900, offsetS: 300 });
    // all-time: B's 280 W beats A at 20 minutes; the hidden 400 W and duplicate 500 W rides do not count
    expect(r.comparison!.points.find((p) => p.durationS === 1200)).toMatchObject({
      watts: 280,
      workoutId: ids.b,
    });
    expect(r.comparison!.points.find((p) => p.durationS === 1)).toMatchObject({
      watts: 900,
      workoutId: ids.a,
    });
    expect(Math.max(...r.comparison!.points.map((p) => p.watts))).toBe(900);
    expect(r.comparison!.points.at(-1)!.durationS).toBe(1800);
    expect(r.comparison!.workouts).toBe(3);
  });

  it('compares with the previous period of the same length', async () => {
    const r = await getJson<ProgressPowerCurveResponse>(
      `/api/progress/power/curve?sport=ride&period=90d&compare=previous&today=${TODAY}`,
    );
    expect(r.current.workouts).toBe(2);
    const prev = r.comparison!;
    expect(prev).toMatchObject({
      fromDay: addDays(TODAY, -179),
      toDay: addDays(TODAY, -90),
      workouts: 0,
      points: [],
    });
    expect(prev.bodyMass!.kg).toBe(70);
    const y = await getJson<ProgressPowerCurveResponse>(
      `/api/progress/power/curve?period=year&year=2026&compare=previous&today=${TODAY}`,
    );
    expect(y.current).toMatchObject({ fromDay: '2026-01-01', toDay: '2026-12-31', workouts: 3 });
    expect(y.comparison).toMatchObject({ fromDay: '2025-01-01', toDay: '2025-12-31', workouts: 0 });
    const all_ = await getJson<ProgressPowerCurveResponse>(
      `/api/progress/power/curve?period=all&compare=previous&today=${TODAY}`,
    );
    expect(all_.compare).toBe('none');
    expect(all_.comparison).toBeNull();
    expect(all_.current.fromDay).toBe(addDays(TODAY, -200));
    const none = await getJson<ProgressPowerCurveResponse>(
      `/api/progress/power/curve?period=12m&compare=none&today=${TODAY}`,
    );
    expect(none.comparison).toBeNull();
    const custom = await getJson<ProgressPowerCurveResponse>(
      `/api/progress/power/curve?period=custom&fromDay=${addDays(TODAY, -61)}&toDay=${addDays(TODAY, -59)}&today=${TODAY}`,
    );
    expect(custom.current.points.map((p) => p.workoutId)).toEqual(custom.current.points.map(() => ids.b));
  });

  it('serves running power separately', async () => {
    const r = await getJson<ProgressPowerCurveResponse>(
      `/api/progress/power/curve?sport=run&period=42d&today=${TODAY}`,
    );
    expect(r.sport).toBe('run');
    expect(r.current.points.find((p) => p.durationS === 1200)).toMatchObject({
      watts: 300,
      workoutId: ids.run,
    });
    expect(r.current.points.at(-1)!.durationS).toBe(1500);
  });

  it('hidden and duplicate workouts are excluded at query time', async () => {
    const url = `/api/progress/power/curve?period=42d&compare=none&today=${TODAY}`;
    run(db, 'UPDATE workouts SET hidden = 0 WHERE id = ?', [ids.hidden!]);
    const shown = await getJson<ProgressPowerCurveResponse>(url);
    expect(shown.current.points.find((p) => p.durationS === 1200)).toMatchObject({
      watts: 400,
      workoutId: ids.hidden,
    });
    run(db, 'UPDATE workouts SET hidden = 1 WHERE id = ?', [ids.hidden!]);
    const hidden = await getJson<ProgressPowerCurveResponse>(url);
    expect(hidden.current.points.some((p) => p.workoutId === ids.hidden || p.workoutId === ids.dup)).toBe(
      false,
    );
  });

  it('estimates FTP from the best 20 minutes of the last 6 weeks, else 90 days', async () => {
    const f = await getJson<ProgressFtpResponse>(`/api/progress/power/ftp?today=${TODAY}`);
    const best20 = Math.round((250 + (10 * 650) / 1200) * 10) / 10;
    expect(f).toMatchObject({ sport: 'ride', factor: 0.95, windowDays: 42 });
    expect(f.source).toMatchObject({ workoutId: ids.a, durationS: 1200, watts: best20 });
    expect(f.ftp).toBeCloseTo(0.95 * best20, 1);
    expect(f.ftpWkg).toBeCloseTo(f.ftp! / 72, 2);
    // A's bests between 3 and 20 minutes are 250 W + 6.5 kJ / t: exactly the critical power model
    expect(f.criticalPowerIssue).toBeNull();
    expect(f.criticalPower!.cpW).toBeCloseTo(250, 0);
    expect(Math.abs(f.criticalPower!.wPrimeJ - 6500)).toBeLessThan(100);
    expect(f.criticalPower!.cpWkg).toBeCloseTo(f.criticalPower!.cpW / 72, 2);
    // 35 days later A is no longer within 6 weeks, but within 90 days
    const later = await getJson<ProgressFtpResponse>(
      `/api/progress/power/ftp?sport=ride&today=${addDays(TODAY, 35)}`,
    );
    expect(later.windowDays).toBe(90);
    expect(later.source).toMatchObject({ workoutId: ids.a, watts: best20 });
    const none = await getJson<ProgressFtpResponse>(
      `/api/progress/power/ftp?sport=ride&today=${addDays(TODAY, 100)}`,
    );
    expect(none).toMatchObject({ windowDays: null, ftp: null, source: null, criticalPower: null });
  });

  it('fits critical power to the bests of several workouts', async () => {
    // one all-out effort per duration on the curve P = 260 W + 18 kJ / t, each followed by an easy 10 minutes
    const durations = [180, 240, 300, 360, 480, 600, 720, 900, 1200];
    for (const d of durations) {
      insertPowerWorkout({
        sport: 'handcycle',
        day: addDays(TODAY, -7),
        st: stream((t) => (t < d ? 260 + 18_000 / d : 100), d + 600),
      });
    }
    await workoutCachesStep.run(ctx());
    const f = await getJson<ProgressFtpResponse>(`/api/progress/power/ftp?sport=handcycle&today=${TODAY}`);
    expect(f.criticalPowerIssue).toBeNull();
    expect(f.criticalPower!.cpW).toBeCloseTo(260, 0);
    expect(Math.abs(f.criticalPower!.wPrimeJ - 18_000)).toBeLessThan(100);
    expect(f.criticalPower!.durations).toEqual(durations);
    expect(f.ftp).toBe(Math.round(0.95 * 275 * 10) / 10);
  });

  it('keeps an FTP history per month', async () => {
    const f = await getJson<ProgressFtpResponse>(`/api/progress/power/ftp?sport=ride&today=${TODAY}`);
    expect(f.history.bucket).toBe('month');
    const keys = f.history.points.map((p) => p.key);
    expect(keys[0]).toBe(addDays(TODAY, -200).slice(0, 7));
    expect(keys.at(-1)).toBe(TODAY.slice(0, 7));
    const monthOfB = f.history.points.find((p) => p.key === addDays(TODAY, -60).slice(0, 7))!;
    expect(monthOfB.ftp).toBe(266);
    expect(monthOfB.source!.workoutId).toBe(ids.b);
    expect(monthOfB.ftpWkg).toBeCloseTo(266 / 70, 2);
    // the months of A, B and F (whose two 30-minute parts have 20-minute bests, too)
    expect(f.history.points.filter((p) => p.ftp !== null).map((p) => p.source!.workoutId)).toEqual([
      ids.f,
      ids.b,
      ids.a,
    ]);
  });

  it('fills missing rows lazily on first use', async () => {
    run(db, 'DELETE FROM progress_power_state');
    run(db, 'DELETE FROM progress_power_bests');
    const r = await getJson<ProgressPowerCurveResponse>(
      `/api/progress/power/curve?period=all&today=${TODAY}`,
    );
    expect(r.current.workouts).toBe(3);
    // hidden / duplicate workouts are not needed for an answer: the lazy fill skips them
    const n = get<{ n: number }>(
      db,
      'SELECT COUNT(*) AS n FROM progress_power_state WHERE workout_id IN (?, ?)',
      [ids.hidden!, ids.dup!],
    )!.n;
    expect(n).toBe(0);
    expect(ensurePowerBests(db, 1)).toBe(0);
  });

  it('answers without any power data', async () => {
    run(db, 'UPDATE workouts SET hidden = 1');
    const r = await getJson<ProgressPowerCurveResponse>(`/api/progress/power/curve?today=${TODAY}`);
    expect(r).toMatchObject({ sport: 'ride', sports: [], years: [] });
    expect((r.current as ProgressPowerCurve).points).toEqual([]);
    const f = await getJson<ProgressFtpResponse>(`/api/progress/power/ftp?today=${TODAY}`);
    expect(f).toMatchObject({ ftp: null, history: { points: [] } });
    run(db, 'UPDATE workouts SET hidden = 0 WHERE id <> ?', [ids.hidden!]);
  });

  it('validates its input', async () => {
    expect(await status('/api/progress/power/curve?period=week')).toBe(400);
    expect(await status('/api/progress/power/curve?period=custom')).toBe(400);
    expect(await status('/api/progress/power/curve?period=custom&fromDay=2026-05-02&toDay=2026-05-01')).toBe(
      400,
    );
    expect(await status('/api/progress/power/curve?compare=best')).toBe(400);
    expect(await status('/api/progress/power/curve?sport=quidditch')).toBe(400);
    expect(await status('/api/progress/power/curve?period=year&year=12')).toBe(400);
    expect(await status('/api/progress/power/ftp?today=2026-02-30')).toBe(400);
  });
});
