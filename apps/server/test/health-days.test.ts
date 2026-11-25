import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BloodPressureReading, HeartEvent, IntradayResponse, MetricSample, MetricSources, Page } from '@cadence/shared';
import { run } from '../src/db/db';
import { addDays } from '../src/lib/time';
import { buildIntraday } from '../src/features/health/intraday';
import { resolveType } from '../src/features/health/util';
import { SRC, createHealthFixture, ts, type HealthFixture } from './health-fixture';

/**
 * Local days on the health routes: the newest blood pressure readings come back when there are more than the limit,
 * the local-day bounds apply before the limit, and days that do not exist in the calendar are a 400.
 */
let fx: HealthFixture;
const SYS = 'HKQuantityTypeIdentifierBloodPressureSystolic';
const DIA = 'HKQuantityTypeIdentifierBloodPressureDiastolic';
const FIRST = '2026-01-01';
const DAYS = 40; // two readings a day: 07:00 and 23:30 (+01:00; 23:30 local is 22:30 UTC the same day)

const bp = (iso: string, systolic: number, diastolic: number) =>
  run(
    fx.db,
    `INSERT INTO correlations (athlete_id, type, start_ts, end_ts, tz_min, source_id, items)
     VALUES (1, 'HKCorrelationTypeIdentifierBloodPressure', ?, ?, 60, 3, ?)`,
    [
      ts(iso),
      ts(iso),
      JSON.stringify([
        { type: SYS, value: systolic, unit: 'mmHg', text: null },
        { type: DIA, value: diastolic, unit: 'mmHg', text: null },
      ]),
    ],
  );

const readings = (query = '') => fx.getJson<BloodPressureReading[]>(`/api/health/body/blood-pressure${query}`);
const times = (r: BloodPressureReading[]) => r.map((x) => `${x.day} ${x.systolic}`);

beforeAll(async () => {
  fx = await createHealthFixture();
  fx.T.hr = fx.addType(1, 'HKQuantityTypeIdentifierHeartRate', 'quantity', 'count/min', 'avg');
  fx.T.sys = fx.addType(2, SYS, 'quantity', 'mmHg', 'avg');
  fx.T.dia = fx.addType(3, DIA, 'quantity', 'mmHg', 'avg');
  fx.T.high = fx.addType(4, 'HKCategoryTypeIdentifierHighHeartRateEvent', 'category', null, 'duration');
  for (let i = 0; i < DAYS; i++) {
    const day = addDays(FIRST, i);
    bp(`${day}T07:00:00+01:00`, 100 + i, 70); // systolic numbers the day: 100 … 139 in the morning
    bp(`${day}T23:30:00+01:00`, 200 + i, 80); // 200 … 239 in the evening
  }
  fx.rec(fx.T.hr!, '2026-02-10T10:00:00+01:00', '2026-02-10T10:00:00+01:00', { value: 60 });
  fx.refreshStats();
}, 60_000);

afterAll(async () => {
  await fx?.close();
});

describe('blood pressure: the newest readings of a range', () => {
  it('returns the newest readings, oldest first, when there are more than the limit', async () => {
    const all = await readings();
    expect(all).toHaveLength(2 * DAYS);
    const last = addDays(FIRST, DAYS - 1);
    const newest = await readings('?limit=3');
    expect(times(newest)).toEqual([`${addDays(last, -1)} 238`, `${last} 139`, `${last} 239`]);
    expect(newest.map((r) => r.ts)).toEqual([...newest.map((r) => r.ts)].sort((a, b) => a - b));
  });

  it('applies the local days before the limit (a late reading belongs to its own local day)', async () => {
    // 2026-01-10 … 2026-01-12 hold six readings; the UTC window around them also holds the evening of the 9th
    const r = await readings('?fromDay=2026-01-10&toDay=2026-01-12&limit=4');
    expect(times(r)).toEqual(['2026-01-11 110', '2026-01-11 210', '2026-01-12 111', '2026-01-12 211']);
    const firstDays = await readings('?fromDay=2026-01-10&toDay=2026-01-12&limit=100');
    expect(times(firstDays)).toEqual(['2026-01-10 109', '2026-01-10 209', '2026-01-11 110', '2026-01-11 210', '2026-01-12 111', '2026-01-12 211']);
  });

  it('pairs separate systolic and diastolic records the same way when there are no correlations', async () => {
    run(fx.db, 'DELETE FROM correlations');
    for (let i = 0; i < 5; i++) {
      const day = addDays('2026-03-01', i);
      fx.rec(fx.T.sys!, `${day}T08:00:00+01:00`, `${day}T08:00:00+01:00`, { value: 120 + i, source: SRC.scale });
      fx.rec(fx.T.dia!, `${day}T08:00:00+01:00`, `${day}T08:00:00+01:00`, { value: 80, source: SRC.scale });
    }
    expect(times(await readings('?limit=2'))).toEqual(['2026-03-04 123', '2026-03-05 124']);
    expect(times(await readings('?toDay=2026-03-02&limit=1'))).toEqual(['2026-03-02 121']);
  });
});

describe('health routes: samples of local days', () => {
  // 2026-02-10 locally: 10:00 and 23:30 at +01:00 (23:30 is still the 10th, 22:30 UTC) and 21:00 at −05:00 (02:00 UTC
  // on the 11th); 00:30 at +01:00 on the 11th is 23:30 UTC on the 10th but belongs to the 11th
  const DAY = '2026-02-10';
  const samples = (offset = 0) =>
    fx.getJson<Page<MetricSample>>(`/api/health/metric/samples?type=HeartRate&fromDay=${DAY}&toDay=${DAY}&limit=2&offset=${offset}`);

  beforeAll(() => {
    fx.rec(fx.T.hr!, `${DAY}T23:30:00+01:00`, `${DAY}T23:30:00+01:00`, { value: 61 });
    fx.rec(fx.T.hr!, `${DAY}T21:00:00-05:00`, `${DAY}T21:00:00-05:00`, { value: 62, tz: -300 });
    fx.rec(fx.T.hr!, '2026-02-11T00:30:00+01:00', '2026-02-11T00:30:00+01:00', { value: 70 });
    fx.refreshStats();
  });

  it('finds the samples of a local day by their own offsets, on every page and in the sources', async () => {
    const first = await samples();
    expect(first.total).toBe(3);
    expect(first.items.map((x) => x.value)).toEqual([62, 61]); // newest first: 02:00 UTC, then 22:30 UTC
    const second = await samples(2);
    expect(second).toMatchObject({ total: 3, offset: 2 });
    expect(second.items.map((x) => x.value)).toEqual([60]);
    const src = await fx.getJson<MetricSources>(`/api/health/metric/sources?type=HeartRate&fromDay=${DAY}&toDay=${DAY}`);
    expect(src.total).toBe(3);
    const day = await fx.getJson<IntradayResponse>(`/api/health/intraday?type=HeartRate&day=${DAY}`);
    expect(day.sampleCount).toBe(3);
    const next = await fx.getJson<Page<MetricSample>>('/api/health/metric/samples?type=HeartRate&fromDay=2026-02-11&toDay=2026-02-11');
    expect(next.items.map((x) => x.value)).toEqual([70]);
  });

  it('counts a range again once its type has new samples', async () => {
    expect((await samples()).total).toBe(3);
    fx.rec(fx.T.hr!, `${DAY}T12:00:00+01:00`, `${DAY}T12:00:00+01:00`, { value: 63 });
    fx.refreshStats();
    expect((await samples()).total).toBe(4);
    expect((await samples(2)).total).toBe(4);
  });

  it('limits heart notifications after keeping only the days asked for', async () => {
    fx.rec(fx.T.high!, `${DAY}T18:00:00+01:00`, `${DAY}T18:10:00+01:00`, { text: 'NotApplicable' });
    fx.rec(fx.T.high!, '2026-02-11T00:30:00+01:00', '2026-02-11T00:40:00+01:00', { text: 'NotApplicable' });
    const ev = await fx.getJson<HeartEvent[]>(`/api/health/heart/events?fromDay=${DAY}&toDay=${DAY}&limit=1`);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'high', ts: ts(`${DAY}T18:00:00+01:00`) });
  });
});

describe('health routes: days that do not exist in the calendar', () => {
  it('answers 400 instead of failing or returning an empty range', async () => {
    for (const url of [
      '/api/health/intraday?type=HeartRate&day=2026-02-30',
      '/api/health/intraday?type=HeartRate&day=2026-13-45',
      '/api/health/metric/samples?type=HeartRate&fromDay=2026-02-01&toDay=2026-02-30',
      '/api/health/metric/series?type=HeartRate&fromDay=2026-02-30',
      '/api/health/metric/sources?type=HeartRate&toDay=2026-02-31',
      '/api/health/heart/events?fromDay=2026-02-29',
      '/api/health/body/blood-pressure?toDay=2026-04-31',
      '/api/health/sleep/nights?fromDay=2026-06-31',
      '/api/health/daily?metrics=HKQuantityTypeIdentifierHeartRate&toDay=2026-00-10',
    ]) {
      const res = await fx.app.inject({ url });
      expect(res.statusCode, url).toBe(400);
    }
    // real days still work, leap days included
    expect((await fx.app.inject({ url: '/api/health/metric/samples?type=HeartRate&fromDay=2024-02-29&toDay=2026-02-28' })).statusCode).toBe(200);
  });

  it('rejects an impossible day as a bad request when the intraday view is built directly', () => {
    const type = resolveType(fx.db, 'HeartRate');
    expect(() => buildIntraday(fx.db, 1, type, '2026-02-30', 5, 60)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});
