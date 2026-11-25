import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DailyMetric,
  HealthMeta,
  HealthOverview,
  HealthSnapshot,
  HeartEvent,
  IntradayResponse,
  SleepNight,
  SleepNightDetail,
} from '@cadence/shared';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { all, openDb, run, type Db } from '../src/db/db';
import { addDays } from '../src/lib/time';
import { rebuildSleepNights } from '../src/features/health/sleep';
import { bucketize } from '../src/features/health/intraday';
import { parseThreshold } from '../src/features/health/heart-routes';
import { summarizeWindows } from '../src/features/health/overview';

let dir: string;
let db: Db;
let app: FastifyInstance;

const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);
let hashSeq = 1;
const T = { sleep: 0, hr: 0, hrv: 0, resp: 0, spo2: 0, wrist: 0, rhr: 0, steps: 0, weight: 0, mindful: 0, hrEvent: 0, bpSys: 0, bpDia: 0 };
const SRC = { phone: 1, watch: 2, scale: 3 };

function addType(id: number, identifier: string, kind: string, unit: string | null, aggregation: string): number {
  run(db, 'INSERT INTO record_types (id, identifier, kind, unit, aggregation) VALUES (?, ?, ?, ?, ?)', [id, identifier, kind, unit, aggregation]);
  return id;
}

function rec(typeId: number, startIso: string, endIso: string, o: { tz?: number; value?: number | null; text?: string | null; source?: number } = {}): void {
  run(
    db,
    `INSERT INTO records (athlete_id, type_id, start_ts, hash, end_ts, tz_min, value, text, source_id)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [typeId, ts(startIso), hashSeq++, ts(endIso), o.tz ?? 60, o.value ?? null, o.text ?? null, o.source ?? SRC.watch],
  );
}

function daily(metric: string, day: string, value: number, extra: { min?: number; max?: number; n?: number } = {}): void {
  run(db, 'INSERT OR REPLACE INTO daily_metrics (athlete_id, metric, day, value, min, max, n) VALUES (1, ?, ?, ?, ?, ?, ?)', [
    metric,
    day,
    value,
    extra.min ?? null,
    extra.max ?? null,
    extra.n ?? 1,
  ]);
}

/** One staged Apple Watch night ending on `wakeDay` at 06:30 local (+01:00): bed the evening before 23:00. */
function seedNight(wakeDay: string, opts: { asleepFrom?: string } = {}): void {
  const prev = addDays(wakeDay, -1);
  rec(T.sleep, `${prev}T22:50:00+01:00`, `${wakeDay}T06:40:00+01:00`, { text: 'InBed', source: SRC.phone });
  const from = opts.asleepFrom ?? `${prev}T23:00:00+01:00`;
  rec(T.sleep, from, `${wakeDay}T00:30:00+01:00`, { text: 'AsleepCore' });
  rec(T.sleep, `${wakeDay}T00:30:00+01:00`, `${wakeDay}T01:30:00+01:00`, { text: 'AsleepDeep' });
  rec(T.sleep, `${wakeDay}T01:30:00+01:00`, `${wakeDay}T01:40:00+01:00`, { text: 'Awake' });
  rec(T.sleep, `${wakeDay}T01:40:00+01:00`, `${wakeDay}T04:00:00+01:00`, { text: 'AsleepCore' });
  rec(T.sleep, `${wakeDay}T04:00:00+01:00`, `${wakeDay}T05:00:00+01:00`, { text: 'AsleepREM' });
  rec(T.sleep, `${wakeDay}T05:00:00+01:00`, `${wakeDay}T06:30:00+01:00`, { text: 'AsleepCore' });
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-health-'));
  const config = loadConfig({ CADENCE_DATA_DIR: dir, CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
  db = openDb(':memory:');
  migrateAll(db);
  app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();

  run(db, "INSERT INTO sources (id, name) VALUES (1, 'iPhone von Hannes'), (2, 'Apple Watch von Hannes'), (3, 'Withings')");
  T.sleep = addType(1, 'HKCategoryTypeIdentifierSleepAnalysis', 'category', null, 'duration');
  T.hr = addType(2, 'HKQuantityTypeIdentifierHeartRate', 'quantity', 'count/min', 'avg');
  T.hrv = addType(3, 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN', 'quantity', 'ms', 'avg');
  T.resp = addType(4, 'HKQuantityTypeIdentifierRespiratoryRate', 'quantity', 'count/min', 'avg');
  T.spo2 = addType(5, 'HKQuantityTypeIdentifierOxygenSaturation', 'quantity', '%', 'avg');
  T.wrist = addType(6, 'HKQuantityTypeIdentifierAppleSleepingWristTemperature', 'quantity', 'degC', 'avg');
  T.rhr = addType(7, 'HKQuantityTypeIdentifierRestingHeartRate', 'quantity', 'count/min', 'avg');
  T.steps = addType(8, 'HKQuantityTypeIdentifierStepCount', 'quantity', 'count', 'sum');
  T.weight = addType(9, 'HKQuantityTypeIdentifierBodyMass', 'quantity', 'kg', 'avg');
  T.mindful = addType(10, 'HKCategoryTypeIdentifierMindfulSession', 'category', null, 'duration');
  T.hrEvent = addType(11, 'HKCategoryTypeIdentifierHighHeartRateEvent', 'category', null, 'duration');
  T.bpSys = addType(12, 'HKQuantityTypeIdentifierBloodPressureSystolic', 'quantity', 'mmHg', 'avg');
  T.bpDia = addType(13, 'HKQuantityTypeIdentifierBloodPressureDiastolic', 'quantity', 'mmHg', 'avg');
}, 60_000);

afterAll(async () => {
  await app?.close();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const getJson = async <T>(url: string): Promise<T> => {
  const res = await app.inject({ url });
  expect(res.statusCode, `${url}: ${res.body.slice(0, 300)}`).toBe(200);
  return res.json<T>();
};

function refreshStats(): void {
  run(db, 'DELETE FROM record_type_stats');
  run(
    db,
    `INSERT INTO record_type_stats (athlete_id, type_id, count, first_ts, last_ts)
     SELECT athlete_id, type_id, COUNT(*), MIN(start_ts), MAX(start_ts) FROM records GROUP BY athlete_id, type_id`,
  );
}

describe('health feature: empty database', () => {
  it('answers without data', async () => {
    expect(await getJson<HealthMeta>('/api/health/meta')).toMatchObject({ asOf: null, firstDay: null, sleepNights: 0, ecgCount: 0, sleepGoalMin: 480 });
    expect(await getJson<HealthOverview>('/api/health/overview')).toEqual({ asOf: null, cards: [] });
    expect(await getJson<HealthSnapshot>('/api/health/snapshot')).toMatchObject({ asOf: null, restingHr: null, sleep: null });
    expect(await getJson<SleepNight[]>('/api/health/sleep/nights')).toEqual([]);
    expect((await app.inject({ url: '/api/health/sleep/night' })).statusCode).toBe(404);
  });
});

describe('health feature: sleep derive step and routes', () => {
  it('derives nights from sleep records and serves them with physiology', async () => {
    seedNight('2026-03-10');
    seedNight('2026-03-11');
    seedNight('2026-03-12');
    // a nap on the 11th
    rec(T.sleep, '2026-03-11T14:00:00+01:00', '2026-03-11T14:30:00+01:00', { text: 'AsleepCore' });
    // physiology during the night of the 11th
    for (let m = 0; m < 360; m += 30) {
      const t0 = ts('2026-03-11T00:00:00+01:00') + m * 60;
      run(db, `INSERT INTO records (athlete_id, type_id, start_ts, hash, end_ts, tz_min, value, source_id) VALUES (1, ?, ?, ?, ?, 60, ?, 2)`, [T.hr, t0, hashSeq++, t0, 48 + (m % 60 === 0 ? 4 : 0)]);
    }
    rec(T.hrv, '2026-03-11T02:10:00+01:00', '2026-03-11T02:11:00+01:00', { value: 58 });
    rec(T.resp, '2026-03-11T03:00:00+01:00', '2026-03-11T03:00:00+01:00', { value: 14.2 });
    rec(T.spo2, '2026-03-11T03:10:00+01:00', '2026-03-11T03:10:00+01:00', { value: 0.96 });
    rec(T.wrist, '2026-03-10T23:05:00+01:00', '2026-03-11T06:30:00+01:00', { value: 36.1 });
    refreshStats();

    const n = rebuildSleepNights(db, 1, null);
    expect(n).toBe(4);

    const nights = await getJson<SleepNight[]>('/api/health/sleep/nights?kind=night');
    expect(nights.map((x) => x.day)).toEqual(['2026-03-10', '2026-03-11', '2026-03-12']);
    const first = nights[0]!;
    expect(first).toMatchObject({ kind: 'night', staged: true, source: 'Apple Watch von Hannes', tzBedMin: 60 });
    expect(first.inBedS).toBe(7 * 3600 + 50 * 60);
    expect(first.coreS).toBe((90 + 140 + 90) * 60);
    expect(first.deepS).toBe(60 * 60);
    expect(first.remS).toBe(60 * 60);
    expect(first.awakenings).toBe(1);
    expect(first.latencyS).toBe(10 * 60);

    const withNaps = await getJson<SleepNight[]>('/api/health/sleep/nights?kind=all&fromDay=2026-03-11&toDay=2026-03-11');
    expect(withNaps.map((x) => x.kind).sort()).toEqual(['nap', 'night']);
    const napOnly = await getJson<SleepNight[]>('/api/health/sleep/nights?kind=nap');
    expect(napOnly).toHaveLength(1);
    expect(napOnly[0]!.asleepS).toBe(30 * 60);

    const detail = await getJson<SleepNightDetail>('/api/health/sleep/night?day=2026-03-11');
    expect(detail.day).toBe('2026-03-11');
    expect(detail.segments.length).toBeGreaterThan(5);
    expect(detail.segments[0]!.startTs).toBe(detail.bedTs);
    expect(detail.segments[detail.segments.length - 1]!.endTs).toBe(detail.wakeTs);
    expect(detail.physiology.hr.length).toBe(12);
    expect(detail.physiology.hrMin).toBe(48);
    expect(detail.physiology.hrv).toEqual([{ ts: ts('2026-03-11T02:10:00+01:00'), value: 58 }]);
    expect(detail.physiology.respAvg).toBeCloseTo(14.2, 6);
    expect(detail.physiology.spo2Avg).toBeCloseTo(0.96, 6);
    expect(detail.physiology.wristTemp).toMatchObject({ value: 36.1, baseline: null, delta: null });

    // by id, latest night without parameters, unknown day → 404
    const byId = await getJson<SleepNightDetail>(`/api/health/sleep/night?id=${first.id}`);
    expect(byId.day).toBe('2026-03-10');
    expect((await getJson<SleepNightDetail>('/api/health/sleep/night')).day).toBe('2026-03-12');
    expect((await app.inject({ url: '/api/health/sleep/night?day=2030-01-01' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/health/sleep/night?day=garbage' })).statusCode).toBe(400);
  });

  it('rebuilds only the affected nights incrementally', () => {
    const before = all<{ id: number; day: string }>(db, `SELECT id, day FROM health_sleep_nights WHERE kind = 'night' ORDER BY day`);
    seedNight('2026-03-20');
    refreshStats(); // the core derive step maintains record_type_stats before feature steps run
    const n = rebuildSleepNights(db, 1, '2026-03-20');
    expect(n).toBe(1);
    const after = all<{ id: number; day: string }>(db, `SELECT id, day FROM health_sleep_nights WHERE kind = 'night' ORDER BY day`);
    expect(after.map((x) => x.day)).toEqual([...before.map((x) => x.day), '2026-03-20']);
    // existing nights keep their ids (they were not rebuilt)
    expect(after.slice(0, before.length)).toEqual(before);
    // a full rebuild gives the same nights
    expect(rebuildSleepNights(db, 1, null)).toBe(5);
  });

  it('reflects the nights in meta, overview and snapshot', async () => {
    const meta = await getJson<HealthMeta>('/api/health/meta');
    expect(meta.sleepNights).toBe(4);
    const snap = await getJson<HealthSnapshot>('/api/health/snapshot');
    expect(snap.sleep).toMatchObject({ day: '2026-03-20' });
    expect(snap.sleep!.value).toBeCloseTo(90 + 60 + 140 + 60 + 90, 0);
  });
});

describe('health feature: overview', () => {
  it('summarizes windows: discrete metrics average over days with data, cumulative metrics count empty days as 0', () => {
    const rows = [
      { day: '2026-03-30', value: 10 },
      { day: '2026-03-29', value: 20 },
    ].reverse();
    const discrete = summarizeWindows(rows, '2026-03-30', '2026-01-01', false, 60);
    expect(discrete.avg30).toBe(15);
    expect(discrete.n30).toBe(2);
    expect(discrete.avgPrev30).toBeNull();
    expect(discrete.spark).toHaveLength(60);
    expect(discrete.spark[59]).toBe(10);
    expect(discrete.spark[58]).toBe(20);
    expect(discrete.spark[0]).toBeNull();
    const cumulative = summarizeWindows(rows, '2026-03-30', '2026-01-01', true, 60);
    expect(cumulative.n30).toBe(30);
    expect(cumulative.avg30).toBeCloseTo(30 / 30, 9);
    // days before the first record do not count as zero
    const young = summarizeWindows(rows, '2026-03-30', '2026-03-29', true, 60);
    expect(young.n30).toBe(2);
    expect(young.avg30).toBe(15);
    expect(young.avgPrev30).toBeNull();
  });

  it('computes the cards with correct windows and sparkline from daily metrics', async () => {
    // resting HR: 60 days, previous 30 days at 56, last 30 days at 52 → improved by 4 bpm
    run(db, 'DELETE FROM daily_metrics');
    for (let i = 0; i < 60; i++) {
      const day = addDays('2026-03-30', -i);
      daily('HKQuantityTypeIdentifierRestingHeartRate', day, i < 30 ? 52 : 56);
      daily('HKQuantityTypeIdentifierStepCount', day, i < 30 ? 12000 : 8000);
    }
    // records so that asOf = 2026-03-30 (reaching into its last hour: the 30th is a complete day)
    rec(T.steps, '2026-03-30T23:30:00+02:00', '2026-03-30T23:35:00+02:00', { value: 100, tz: 120 });
    refreshStats();
    const o = await getJson<HealthOverview>('/api/health/overview');
    expect(o.asOf).toBe('2026-03-30');
    const rhr = o.cards.find((c) => c.key === 'restingHr')!;
    expect(rhr.latest).toBe(52);
    expect(rhr.latestDay).toBe('2026-03-30');
    expect(rhr.avg30).toBe(52);
    expect(rhr.avgPrev30).toBe(56);
    expect(rhr.n30).toBe(30);
    expect(rhr.nPrev30).toBe(30);
    expect(rhr.avg30! - rhr.avgPrev30!).toBe(-4); // negative: resting HR went down
    expect(rhr.spark).toHaveLength(60);
    expect(rhr.spark[0]).toBe(56);
    expect(rhr.spark[59]).toBe(52);
    expect(o.cards.find((c) => c.key === 'steps')!.avg30).toBe(12000);
    // metrics without data are omitted
    expect(o.cards.find((c) => c.key === 'vo2max')).toBeUndefined();
  });

  it('serves several daily series at once and validates the request', async () => {
    const d = await getJson<Record<string, DailyMetric[]>>(
      '/api/health/daily?metrics=HKQuantityTypeIdentifierRestingHeartRate,HKQuantityTypeIdentifierStepCount&fromDay=2026-03-28&toDay=2026-03-30',
    );
    expect(Object.keys(d)).toEqual(['HKQuantityTypeIdentifierRestingHeartRate', 'HKQuantityTypeIdentifierStepCount']);
    expect(d['HKQuantityTypeIdentifierRestingHeartRate']!.map((x) => x.day)).toEqual(['2026-03-28', '2026-03-29', '2026-03-30']);
    expect((await app.inject({ url: '/api/health/daily?metrics=' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/health/daily?metrics=a&fromDay=2026-03-30&toDay=2026-03-01' })).statusCode).toBe(400);
  });

  it('stores the sleep goal', async () => {
    const put = await app.inject({ method: 'PUT', url: '/api/health/settings', payload: { sleepGoalMin: 450 } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ sleepGoalMin: 450 });
    expect((await getJson<HealthMeta>('/api/health/meta')).sleepGoalMin).toBe(450);
    expect((await app.inject({ method: 'PUT', url: '/api/health/settings', payload: { sleepGoalMin: 5 } })).statusCode).toBe(400);
    await app.inject({ method: 'PUT', url: '/api/health/settings', payload: { sleepGoalMin: 480 } });
  });
});

describe('health feature: heart', () => {
  it('lists heart notifications with their thresholds, newest first, filtered by local day', async () => {
    const ev = (iso: string, meta: string | null, typeId = T.hrEvent) =>
      run(
        db,
        `INSERT INTO records (athlete_id, type_id, start_ts, hash, end_ts, tz_min, text, source_id, meta)
         VALUES (1, ?, ?, ?, ?, 60, 'NotApplicable', 2, ?)`,
        [typeId, ts(iso), hashSeq++, ts(iso), meta],
      );
    const irregular = addType(14, 'HKCategoryTypeIdentifierIrregularHeartRhythmEvent', 'category', null, 'duration');
    ev('2026-02-10T08:15:00+01:00', JSON.stringify({ HKMetadataKeyHeartRateEventThreshold: '120 count/min' }));
    ev('2026-03-05T22:30:00+01:00', JSON.stringify({ HKMetadataKeyHeartRateEventThreshold: 130 }));
    ev('2026-03-07T03:00:00+01:00', null, irregular);
    const all = await getJson<HeartEvent[]>('/api/health/heart/events');
    expect(all.map((e) => [e.type, e.threshold])).toEqual([
      ['irregular', null],
      ['high', 130],
      ['high', 120],
    ]);
    expect(all[0]!.source).toBe('Apple Watch von Hannes');
    // 2026-03-05T22:30+01:00 is still the 5th locally
    const some = await getJson<HeartEvent[]>('/api/health/heart/events?fromDay=2026-03-05&toDay=2026-03-05');
    expect(some).toHaveLength(1);
    expect(some[0]!.threshold).toBe(130);
    expect(await getJson<HeartEvent[]>('/api/health/heart/events?fromDay=2025-01-01&toDay=2025-12-31')).toEqual([]);
    expect(parseThreshold('{"HKMetadataKeyHeartRateEventThreshold":"110 count/min"}')).toBe(110);
    expect(parseThreshold('not json')).toBeNull();
    expect(parseThreshold(null)).toBeNull();
  });

  it('buckets samples of a day (avg types by mean/min/max, cumulative types by max over sources)', () => {
    const rows = [
      { start_ts: 1000, tz_min: 0, value: 60, source_id: 1 },
      { start_ts: 1100, tz_min: 0, value: 80, source_id: 1 },
      { start_ts: 1400, tz_min: 0, value: 100, source_id: 1 },
    ];
    expect(bucketize(rows, 1000, 1000 + 86400, 300, 'avg')).toEqual([
      { ts: 1000, avg: 70, min: 60, max: 80, n: 2 },
      { ts: 1300, avg: 100, min: 100, max: 100, n: 1 },
    ]);
    const steps = [
      { start_ts: 1000, tz_min: 0, value: 30, source_id: 1 },
      { start_ts: 1010, tz_min: 0, value: 20, source_id: 1 },
      { start_ts: 1020, tz_min: 0, value: 45, source_id: 2 }, // the watch counted fewer steps than the phone: 50 wins
      { start_ts: 5000, tz_min: 0, value: 10, source_id: 2 },
    ];
    expect(bucketize(steps, 1000, 1000 + 86400, 3600, 'sum')).toEqual([
      { ts: 1000, avg: 50, min: 50, max: 50, n: 2 },
      { ts: 1000 + 3600, avg: 10, min: 10, max: 10, n: 1 },
    ]);
  });

  it('serves the intraday view of one local day', async () => {
    // 2026-03-15 (+01:00): three heart rate samples on the day, one the evening before and one just after midnight
    const hr = (iso: string, value: number) => rec(T.hr, iso, iso, { value });
    hr('2026-03-14T23:50:00+01:00', 41);
    hr('2026-03-15T08:01:00+01:00', 60);
    hr('2026-03-15T08:03:00+01:00', 80);
    hr('2026-03-15T23:59:00+01:00', 55);
    hr('2026-03-16T00:05:00+01:00', 99);
    const r = await getJson<IntradayResponse>('/api/health/intraday?type=HKQuantityTypeIdentifierHeartRate&day=2026-03-15');
    expect(r).toMatchObject({ day: '2026-03-15', tzMin: 60, bucketS: 300, sampleCount: 3, aggregation: 'avg' });
    expect(r.dayStartTs).toBe(ts('2026-03-15T00:00:00+01:00'));
    expect(r.dayEndTs).toBe(ts('2026-03-16T00:00:00+01:00'));
    expect(r.buckets).toHaveLength(2);
    expect(r.buckets[0]).toMatchObject({ ts: ts('2026-03-15T08:00:00+01:00'), avg: 70, min: 60, max: 80, n: 2 });
    // the short identifier works as well, hourly buckets are accepted
    const hourly = await getJson<IntradayResponse>('/api/health/intraday?type=HeartRate&day=2026-03-15&bucket=60');
    expect(hourly.buckets[0]!.ts).toBe(ts('2026-03-15T08:00:00+01:00'));
    // no samples → empty buckets with the fallback offset
    expect((await getJson<IntradayResponse>('/api/health/intraday?type=HeartRate&day=2020-01-01')).buckets).toEqual([]);
    // errors
    expect((await app.inject({ url: '/api/health/intraday?type=HeartRate&day=2026-03-15&bucket=7' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/health/intraday?type=NopeNope&day=2026-03-15' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/health/intraday?type=SleepAnalysis&day=2026-03-15' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/health/intraday?type=HeartRate' })).statusCode).toBe(400);
  });
});
