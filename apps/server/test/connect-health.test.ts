import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MetricSeries } from '@cadence/shared';
import { migrateAll } from '../src/app';
import { all, get, openDb, run, type Db } from '../src/db/db';
import { runDerive } from '../src/derive/run';
import { syncCorosMobile } from '../src/features/connect/coros-health';
import type { MobileDay } from '../src/features/connect/coros-mobile';
import { connectMigrations } from '../src/features/connect/migrations';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-coros-health-'));
  db = openDb(path.join(dir, 'cadence.db'));
  migrateAll(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ymd = (day: string) => Number(day.replace(/-/g, ''));
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const range = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

/** The COROS app API: every day 10,000 steps, 600 kcal, 45 active minutes and a heart rate of 60 (45–150). */
const daily =
  (days: string[]) =>
  async (dataType: number, start: number, end: number): Promise<MobileDay[]> =>
    days
      .map(ymd)
      .filter((d) => d >= start && d <= end)
      .map((happenDay) => ({
        happenDay,
        ...(dataType === 3 ? { step: 10_000 } : {}),
        ...(dataType === 1 ? { calorie: 600_000 } : {}),
        ...(dataType === 2 ? { motionTime: 45 * 60 } : {}),
        ...(dataType === 4 ? { heartRateData: { avgHeartRate: 60, minHeartRate: 45, maxHeartRate: 150 } } : {}),
      }));

const aggregation = (identifier: string) =>
  get<{ aggregation: string }>(db, 'SELECT aggregation FROM record_types WHERE identifier = ?', [identifier])
    ?.aggregation;

async function api<T>(url: string): Promise<T> {
  const { buildApp } = await import('../src/app');
  const { loadConfig } = await import('../src/config');
  const config = loadConfig({ CADENCE_DATA_DIR: dir, CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
  const app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();
  try {
    const res = await app.inject({ url });
    expect(res.statusCode).toBe(200);
    return res.json() as T;
  } finally {
    await app.close();
  }
}

describe('COROS daily totals', () => {
  it('adds up steps, calories and active minutes over weeks and months (types of an earlier version too)', async () => {
    // v1.0.0 registered every COROS metric as an average
    run(db, "INSERT INTO record_types (identifier, kind, unit, aggregation) VALUES ('COROSSteps', 'quantity', 'count', 'avg')");
    // Monday 2026-03-02 to Sunday 2026-03-15
    await syncCorosMobile(db, 1, daily(range('2026-03-02', '2026-03-15')), { sinceDay: null, today: '2026-03-15' });
    for (const id of ['COROSSteps', 'COROSCalories', 'COROSActiveMinutes']) expect(aggregation(id), id).toBe('sum');
    expect(aggregation('COROSHeartRate')).toBe('avg');

    const week = await api<MetricSeries>(
      '/api/health/metric/series?type=COROSSteps&agg=week&fromDay=2026-03-02&toDay=2026-03-15',
    );
    expect(week.type.aggregation).toBe('sum');
    expect(week.points.map((p) => [p.key, p.value])).toEqual([
      ['2026-03-02', 70_000],
      ['2026-03-09', 70_000],
    ]);
    expect(week.stats.total).toBe(140_000);
    // one value per day: the daily values stay as they were
    expect(all(db, "SELECT DISTINCT value, min, max FROM daily_metrics WHERE metric = 'COROSCalories'")).toEqual([
      { value: 600, min: null, max: null },
    ]);
  });

  it('migrates the daily totals an earlier version stored as averages', async () => {
    await syncCorosMobile(db, 1, daily(range('2026-03-02', '2026-03-08')), { sinceDay: null, today: '2026-03-08' });
    // as v1.0.0 left them
    run(db, "UPDATE record_types SET aggregation = 'avg' WHERE identifier LIKE 'COROS%'");
    run(db, "UPDATE daily_metrics SET min = value, max = value WHERE metric LIKE 'COROS%'");
    const m = connectMigrations.find((x) => x.id === 'connect_003_daily_totals')!;
    db.exec(m.up as string);
    for (const id of ['COROSSteps', 'COROSCalories', 'COROSActiveMinutes']) expect(aggregation(id), id).toBe('sum');
    expect(aggregation('COROSHeartRate')).toBe('avg');
    expect(get(db, "SELECT value, min, max FROM daily_metrics WHERE metric = 'COROSSteps' AND day = '2026-03-02'")).toEqual(
      { value: 10_000, min: null, max: null },
    );
    // averages keep their band
    expect(
      get(db, "SELECT value, min, max FROM daily_metrics WHERE metric = 'COROSHeartRateMin' AND day = '2026-03-02'"),
    ).toEqual({ value: 45, min: 45, max: 45 });
  });
});

describe('COROS all-day heart rate', () => {
  const band = () =>
    all<{ day: string; value: number; min: number; max: number }>(
      db,
      "SELECT day, value, min, max FROM daily_metrics WHERE metric = 'COROSHeartRate' ORDER BY day",
    );

  it('keeps the daily low / high band through a rebuild of the analysis', async () => {
    const days = range('2026-03-02', '2026-03-08');
    await syncCorosMobile(db, 1, daily(days), { sinceDay: null, today: '2026-03-08' });
    const expected = days.map((day) => ({ day, value: 60, min: 45, max: 150 }));
    expect(band()).toEqual(expected);
    // "Rebuild analysis" (or the rebuild after an update): every daily metric is computed again
    await runDerive({ db, athleteId: 1, workoutIds: 'all', sinceDay: null });
    expect(band()).toEqual(expected);
    // a rederive from a day on (e.g. another resting HR source)
    await runDerive({ db, athleteId: 1, workoutIds: [], sinceDay: '2026-03-06' });
    expect(band()).toEqual(expected);
  });

  it('keeps the band of the days the daily syncs leave behind', async () => {
    const days = range('2026-01-01', '2026-03-05');
    await syncCorosMobile(db, 1, daily(days.filter((d) => d <= '2026-03-01')), {
      sinceDay: null,
      today: '2026-03-01',
    });
    // the auto sync: one window back from today, from a few days before the last sync on
    for (const today of ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'])
      await syncCorosMobile(db, 1, daily(days.filter((d) => d <= today)), { sinceDay: addDays(today, -4), today });
    expect(band().filter((d) => d.min !== 45 || d.max !== 150)).toEqual([]);
    expect(band()).toHaveLength(days.length);
  });
});
