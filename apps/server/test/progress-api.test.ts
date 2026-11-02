import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BEST_EFFORTS,
  type ImportJob,
  type PaceAtHrResponse,
  type ProgressCompareResponse,
  type ProgressEffortHistory,
  type ProgressFitnessResponse,
  type ProgressIntensityResponse,
  type ProgressOverview,
  type ProgressPhysiology,
  type ProgressPredictions,
  type ProgressRecordsResponse,
  type ProgressTrendsResponse,
  type ProgressVolumeResponse,
  type ProgressWeeklySnapshot,
  type ProgressYoyResponse,
} from '@cadence/shared';
import { generateSample } from '../scripts/sample/generate';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { all, get, openDb, type Db } from '../src/db/db';
import { addDays } from '../src/lib/time';

const TODAY = '2026-02-20';
let dir: string;
let db: Db;
let app: FastifyInstance;

const getJson = async <T>(url: string): Promise<T> => {
  const res = await app.inject({ url });
  expect(res.statusCode, `${url}: ${res.body.slice(0, 300)}`).toBe(200);
  return res.json<T>();
};
const status = async (url: string, method: 'GET' | 'PATCH' = 'GET', payload?: unknown) =>
  (await app.inject({ url, method, payload: payload as never })).statusCode;

async function waitForJob(id: string): Promise<ImportJob> {
  for (let i = 0; i < 4000; i++) {
    const job = (await app.inject({ url: `/api/import/jobs/${id}` })).json<ImportJob>();
    if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job timeout');
}

/** Visible workouts per local day range straight from SQL (cross-check). */
function countWorkouts(sport: string | null, fromDay: string, toDay: string): number {
  return get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM workouts WHERE athlete_id = 1 AND hidden = 0 AND duplicate_of IS NULL
       AND date(start_ts + tz_min * 60, 'unixepoch') BETWEEN ? AND ? ${sport ? 'AND sport = ?' : ''}`,
    sport ? [fromDay, toDay, sport] : [fromDay, toDay],
  )!.n;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-progress-'));
  const config = loadConfig({
    CADENCE_DATA_DIR: path.join(dir, 'data'),
    CADENCE_MODE: 'dev',
    CADENCE_ALLOW_LOCAL_IMPORT: '1',
    LOG_LEVEL: 'silent',
  });
  db = openDb(config.dbPath);
  migrateAll(db);
  app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  db?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('progress API without data', () => {
  it('answers every endpoint with empty results', async () => {
    const o = await getJson<ProgressOverview>('/api/progress/overview');
    expect(o).toMatchObject({ sports: [], defaultSport: null, firstDay: null });
    const f = await getJson<ProgressFitnessResponse>(`/api/progress/fitness?today=${TODAY}`);
    expect(f.days).toEqual([]);
    expect(f.current).toBeNull();
    const r = await getJson<ProgressRecordsResponse>(`/api/progress/records?today=${TODAY}`);
    expect(r.sport).toBeNull();
    const t = await getJson<ProgressTrendsResponse>(`/api/progress/trends?sport=run&today=${TODAY}`);
    expect(t.series).toEqual([]);
    const s = await getJson<ProgressWeeklySnapshot>(`/api/progress/snapshot?today=${TODAY}`);
    expect(s.weeks).toHaveLength(12);
    expect(s.current.totals.count).toBe(0);
    const y = await getJson<ProgressYoyResponse>(`/api/progress/yoy?today=${TODAY}`);
    expect(y.years).toEqual([]);
    const p = await getJson<ProgressPredictions>(`/api/progress/predictions?today=${TODAY}`);
    expect(p.targets.every((x) => x.riegel === null && x.vo2max === null)).toBe(true);
    const ph = await getJson<ProgressPhysiology>(`/api/progress/physiology?today=${TODAY}`);
    expect(ph.vo2max.points).toEqual([]);
  });
});

describe('progress API with the sample export', () => {
  beforeAll(async () => {
    const zip = path.join(dir, 'export.zip');
    await generateSample({ out: zip, size: 'small', seed: 11, endDate: TODAY });
    const res = await app.inject({ method: 'POST', url: '/api/import/local', payload: { path: zip } });
    expect(res.statusCode).toBe(202);
    const job = await waitForJob(res.json<ImportJob>().id);
    expect(job.status, job.error ?? '').toBe('done');
    expect(job.stats.warnings.filter((w) => w.includes('progress'))).toEqual([]);
  }, 180_000);

  it('the derive step caches per-workout metrics', () => {
    const rows = all<{ sport: string; n: number; hist: number; stride: number }>(
      db,
      `SELECT w.sport, COUNT(*) AS n, SUM(m.hr_speed IS NOT NULL) AS hist, SUM(m.stride_m IS NOT NULL) AS stride
       FROM progress_workout_metrics m JOIN workouts w ON w.id = m.workout_id GROUP BY w.sport`,
    );
    const total = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM workouts')!.n;
    expect(rows.reduce((s, r) => s + r.n, 0)).toBe(total);
    const run = rows.find((r) => r.sport === 'run')!;
    expect(run.hist).toBeGreaterThan(0);
    expect(run.stride).toBeGreaterThan(0);
  });

  it('overview lists sports by frequency', async () => {
    const o = await getJson<ProgressOverview>('/api/progress/overview');
    expect(o.sports.length).toBeGreaterThan(2);
    expect(o.defaultSport).toBe(o.sports[0]!.sport);
    for (let i = 1; i < o.sports.length; i++) expect(o.sports[i - 1]!.count).toBeGreaterThanOrEqual(o.sports[i]!.count);
    expect(o.firstDay! <= o.lastDay!).toBe(true);
    expect(o.sports.find((s) => s.sport === 'run')!.bestEffortWorkouts).toBeGreaterThan(0);
  });

  it('volume buckets are contiguous and add up', async () => {
    const from = addDays(TODAY, -55);
    const v = await getJson<ProgressVolumeResponse>(`/api/progress/volume?bucket=week&fromDay=${from}&toDay=${TODAY}`);
    expect(v.bucket).toBe('week');
    for (let i = 1; i < v.buckets.length; i++) expect(v.buckets[i]!.fromDay).toBe(addDays(v.buckets[i - 1]!.fromDay, 7));
    expect(v.buckets[0]!.fromDay <= from).toBe(true);
    expect(v.totals.count).toBe(countWorkouts(null, v.buckets[0]!.fromDay, TODAY));
    for (const b of v.buckets) {
      const sum = Object.values(b.bySport).reduce((s, t) => s + t.count, 0);
      expect(sum).toBe(b.total.count);
    }
    expect(v.rollingWindow).toBe(4);
    expect(v.rolling.distance).toHaveLength(v.buckets.length);
    const runs = await getJson<ProgressVolumeResponse>(`/api/progress/volume?sport=run&bucket=month&fromDay=${from}&toDay=${TODAY}`);
    expect(runs.sports).toEqual(['run']);
    expect(runs.buckets.every((b) => Object.keys(b.bySport).every((s) => s === 'run'))).toBe(true);
  });

  it('year over year accumulates by calendar date', async () => {
    const y = await getJson<ProgressYoyResponse>(`/api/progress/yoy?metric=distance&today=${TODAY}`);
    expect(y.years.map((x) => x.year)).toEqual([2025, 2026]);
    const cur = y.years.at(-1)!;
    expect(cur.cumulative).toHaveLength(y.todayIndex + 1);
    expect(y.years[0]!.cumulative).toHaveLength(366);
    for (const yr of y.years)
      for (let i = 1; i < yr.cumulative.length; i++) expect(yr.cumulative[i]!).toBeGreaterThanOrEqual(yr.cumulative[i - 1]!);
    expect(y.comparison).toMatchObject({ year: 2026, previousYear: 2025, value: cur.cumulative[y.todayIndex] });
    const count = await getJson<ProgressYoyResponse>(`/api/progress/yoy?metric=count&today=${TODAY}`);
    expect(count.years.at(-1)!.total).toBe(countWorkouts(null, '2026-01-01', TODAY));
  });

  it('compares a period with the previous one', async () => {
    const c = await getJson<ProgressCompareResponse>(`/api/progress/compare?sport=run&period=month&today=${TODAY}`);
    expect(c).toMatchObject({ period: 'month', toDate: true, current: { fromDay: '2026-02-01', toDay: TODAY } });
    expect(c.previous).toMatchObject({ fromDay: '2026-01-01', toDay: '2026-01-20' });
    expect(c.current.totals.count).toBe(countWorkouts('run', '2026-02-01', TODAY));
    if (c.current.totals.count) expect(c.current.totals.avgSpeed).toBeGreaterThan(1);
    const custom = await getJson<ProgressCompareResponse>(
      `/api/progress/compare?period=custom&fromDay=2026-02-01&toDay=2026-02-14&today=${TODAY}`,
    );
    expect(custom.previous).toMatchObject({ fromDay: '2026-01-18', toDay: '2026-01-31' });
    expect(custom.current.totals.avgSpeed).toBeNull(); // only for a single sport
    const back = await getJson<ProgressCompareResponse>(`/api/progress/compare?period=week&offset=2&today=${TODAY}`);
    expect(back.toDate).toBe(false);
    expect(back.current.fromDay).toBe(addDays(back.previous.fromDay, 7));
  });

  it('per-activity trends reference visible workouts and fit a line', async () => {
    const t = await getJson<ProgressTrendsResponse>(`/api/progress/trends?sport=run&today=${TODAY}`);
    const speed = t.series.find((s) => s.metric === 'speed')!;
    expect(speed.unit).toBe('m/s');
    expect(speed.better).toBe('up');
    expect(speed.points.length).toBeGreaterThan(5);
    expect(speed.median).toHaveLength(speed.points.length);
    expect(speed.fit).not.toBeNull();
    for (const [i] of speed.points) expect(t.workouts[i]).toBeDefined();
    const ts = speed.points.map(([i]) => t.workouts[i]!.startTs);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    expect(t.series.map((s) => s.metric)).toEqual(expect.arrayContaining(['hr', 'ef', 'cadence', 'stride', 'gct', 'vo']));
    expect(t.series.find((s) => s.metric === 'gct')!.better).toBe('down');
  });

  it('hidden workouts drop out of every aggregate', async () => {
    const run = get<{ id: number; day: string }>(
      db,
      `SELECT id, date(start_ts + tz_min * 60, 'unixepoch') AS day FROM workouts
       WHERE sport = 'run' AND hidden = 0 AND duplicate_of IS NULL AND avg_speed > 0 ORDER BY start_ts DESC LIMIT 1`,
    )!;
    const url = `/api/progress/volume?sport=run&bucket=week&fromDay=${addDays(TODAY, -27)}&toDay=${TODAY}`;
    const before = await getJson<ProgressVolumeResponse>(url);
    const trendsBefore = await getJson<ProgressTrendsResponse>(`/api/progress/trends?sport=run&today=${TODAY}`);
    expect(await status(`/api/workouts/${run.id}`, 'PATCH', { hidden: true })).toBe(200);
    const after = await getJson<ProgressVolumeResponse>(url);
    expect(after.totals.count).toBe(before.totals.count - 1);
    const trendsAfter = await getJson<ProgressTrendsResponse>(`/api/progress/trends?sport=run&today=${TODAY}`);
    expect(trendsAfter.workouts.some((w) => w.id === run.id)).toBe(false);
    expect(trendsAfter.workouts.length).toBe(trendsBefore.workouts.length - 1);
    expect(await status(`/api/workouts/${run.id}`, 'PATCH', { hidden: false })).toBe(200);
  });

  it('pace at heart rate per month, with a saved band', async () => {
    const p = await getJson<PaceAtHrResponse>(`/api/progress/pace-at-hr?sport=run&today=${TODAY}`);
    expect(p.band.hi).toBeGreaterThan(p.band.lo);
    expect(p.suggestions.map((s) => s.key)).toEqual(expect.arrayContaining(['common', 'z2', 'z3']));
    expect(p.months.length).toBeGreaterThanOrEqual(3);
    expect(p.months.some((m) => m.speed !== null && m.speed > 1)).toBe(true);
    expect(p.hrDistribution!.seconds.length).toBeGreaterThan(10);
    const res = await app.inject({ method: 'PATCH', url: '/api/progress/preferences', payload: { hrBands: { run: { lo: 120, hi: 135 } } } });
    expect(res.statusCode).toBe(200);
    const saved = await getJson<PaceAtHrResponse>(`/api/progress/pace-at-hr?sport=run&today=${TODAY}`);
    expect(saved.band).toEqual({ lo: 120, hi: 135 });
    expect(saved.suggestions[0]).toEqual({ key: 'saved', lo: 120, hi: 135 });
    const explicit = await getJson<PaceAtHrResponse>(`/api/progress/pace-at-hr?sport=run&lo=140&hi=150&today=${TODAY}`);
    expect(explicit.band).toEqual({ lo: 140, hi: 150 });
    await app.inject({ method: 'PATCH', url: '/api/progress/preferences', payload: { hrBands: { run: null } } });
  });

  it('intensity distribution sums zone time per week', async () => {
    const r = await getJson<ProgressIntensityResponse>(`/api/progress/intensity?fromDay=${addDays(TODAY, -60)}&toDay=${TODAY}`);
    expect(r.zoneBounds).toHaveLength(4);
    const total = r.buckets.reduce((s, b) => s + b.total, 0);
    expect(total).toBeCloseTo(r.totals.total, 6);
    expect(r.totals.easyShare! + r.totals.hardShare!).toBeCloseTo(1, 9);
    expect(r.coverage.withZones).toBeGreaterThan(0);
  });

  it('records, progression and race predictions', async () => {
    const r = await getJson<ProgressRecordsResponse>(`/api/progress/records?sport=run&today=${TODAY}`);
    expect(r.efforts.map((e) => e.effort)).toEqual(BEST_EFFORTS.run!.map((d) => d.key));
    for (const e of r.efforts) {
      if (e.allTime && e.thisYear) expect(e.allTime.elapsedS).toBeLessThanOrEqual(e.thisYear.elapsedS);
      if (e.attempts === 0) expect(e.allTime).toBeNull();
    }
    expect(r.highlights.map((h) => h.key)).toContain('longest');
    const h = await getJson<ProgressEffortHistory>('/api/progress/records/history?sport=run&effort=1k');
    expect(h.attempts.length).toBe(r.efforts.find((e) => e.effort === '1k')!.attempts);
    expect(h.attempts[0]!.pr).toBe(true);
    let best = Infinity;
    for (const a of h.attempts) {
      expect(a.pr).toBe(a.elapsedS < best);
      best = Math.min(best, a.elapsedS);
    }
    expect(h.top[0]!.elapsedS).toBe(best);
    expect(h.top.length).toBeLessThanOrEqual(10);
    expect(await status('/api/progress/records/history?sport=run&effort=nope')).toBe(404);
    const p = await getJson<ProgressPredictions>(`/api/progress/predictions?today=${TODAY}`);
    expect(p.targets.map((x) => x.key)).toEqual(['5k', '10k', 'half', 'marathon']);
    const five = p.targets[0]!;
    expect(five.riegel!.elapsedS).toBeGreaterThan(600);
    expect(five.vo2max!.elapsedS).toBeGreaterThan(600);
    expect(p.targets[3]!.riegel!.elapsedS).toBeGreaterThan(five.riegel!.elapsedS * 8);
  });

  it('fitness model and physiology', async () => {
    const from = addDays(TODAY, -40);
    const f = await getJson<ProgressFitnessResponse>(`/api/progress/fitness?fromDay=${from}&today=${TODAY}`);
    expect(f.days[0]!.day).toBe(from);
    expect(f.days.at(-1)!.day).toBe(TODAY);
    expect(f.days).toHaveLength(41);
    for (const d of f.days) expect(Math.abs(d.tsb - (d.ctl - d.atl))).toBeLessThan(0.11);
    expect(f.current).toMatchObject({ day: TODAY });
    expect(f.zones.map((z) => z.key)).toEqual(['transition', 'fresh', 'optimal', 'tired', 'overreaching']);
    expect(f.weeks.reduce((s, w) => s + w.count, 0)).toBeGreaterThanOrEqual(countWorkouts(null, from, TODAY));
    const ph = await getJson<ProgressPhysiology>(`/api/progress/physiology?fromDay=${from}&toDay=${TODAY}`);
    expect(ph.vo2max.points.length).toBeGreaterThan(0);
    expect(ph.vo2max.median).toHaveLength(ph.vo2max.points.length);
    expect(ph.vo2max.levels).toHaveLength(5);
    expect(ph.vo2max.level).not.toBeNull();
    expect(ph.restingHr.points.length).toBeGreaterThan(20);
    expect(ph.restingHr.avg7).toHaveLength(ph.restingHr.points.length);
  });

  it('weekly snapshot', async () => {
    const s = await getJson<ProgressWeeklySnapshot>(`/api/progress/snapshot?today=${TODAY}`);
    expect(s.weeks).toHaveLength(12);
    expect(s.weeks.at(-1)!.key).toBe(s.current.fromDay);
    expect(s.current.toDay).toBe(TODAY);
    expect(s.previousFull.toDay).toBe(addDays(s.current.fromDay, -1));
    expect(s.weeks.at(-1)!.totals.count).toBe(s.current.totals.count);
  });

  it('validates its input', async () => {
    expect(await status('/api/progress/volume?sport=quidditch')).toBe(400);
    expect(await status('/api/progress/volume?fromDay=2026-13-01')).toBe(400);
    expect(await status('/api/progress/volume?fromDay=2026-02-10&toDay=2026-02-01')).toBe(400);
    expect(await status('/api/progress/trends')).toBe(400);
    expect(await status('/api/progress/pace-at-hr?sport=run&lo=150&hi=140')).toBe(400);
    expect(await status('/api/progress/pace-at-hr?sport=run&lo=150')).toBe(400);
    expect(await status('/api/progress/compare?period=custom')).toBe(400);
    expect(await status('/api/progress/preferences', 'PATCH', { hrBands: { run: { lo: 150, hi: 140 } } })).toBe(400);
  });
});
