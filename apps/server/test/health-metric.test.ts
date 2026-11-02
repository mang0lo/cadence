import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BloodPressureReading,
  ExplorerResponse,
  MetricSample,
  MetricSeries,
  MetricSources,
  Page,
} from '@cadence/shared';
import { run } from '../src/db/db';
import { addDays } from '../src/lib/time';
import { aggregatePoints, combineCategoryRows, periodStart, summarize } from '../src/features/health/series';
import { SRC, createHealthFixture, ts, type HealthFixture } from './health-fixture';

let fx: HealthFixture;
const get = <T>(url: string) => fx.getJson<T>(url);

beforeAll(async () => {
  fx = await createHealthFixture();
  fx.T.steps = fx.addType(1, 'HKQuantityTypeIdentifierStepCount', 'quantity', 'count', 'sum');
  fx.T.weight = fx.addType(2, 'HKQuantityTypeIdentifierBodyMass', 'quantity', 'kg', 'avg');
  fx.T.sleep = fx.addType(3, 'HKCategoryTypeIdentifierSleepAnalysis', 'category', null, 'duration');
  fx.T.bpSys = fx.addType(4, 'HKQuantityTypeIdentifierBloodPressureSystolic', 'quantity', 'mmHg', 'avg');
  fx.T.bpDia = fx.addType(5, 'HKQuantityTypeIdentifierBloodPressureDiastolic', 'quantity', 'mmHg', 'avg');
}, 60_000);

afterAll(async () => {
  await fx?.close();
});

describe('series aggregation (pure)', () => {
  it('finds the start of a week for Monday and Sunday weeks, and of a month', () => {
    // 2026-03-15 is a Sunday
    expect(periodStart('2026-03-15', 'week', 1)).toBe('2026-03-09');
    expect(periodStart('2026-03-15', 'week', 0)).toBe('2026-03-15');
    expect(periodStart('2026-03-16', 'week', 1)).toBe('2026-03-16');
    expect(periodStart('2026-03-16', 'week', 0)).toBe('2026-03-15');
    expect(periodStart('2026-03-01', 'week', 1)).toBe('2026-02-23'); // across the month boundary
    expect(periodStart('2026-03-15', 'month', 1)).toBe('2026-03-01');
    expect(periodStart('2026-03-15', 'day', 1)).toBe('2026-03-15');
  });

  it('adds up cumulative metrics and averages discrete ones (mean of daily means, extremes of the samples)', () => {
    const rows = [
      { day: '2026-03-09', value: 10, min: 1, max: 20, n: 4 },
      { day: '2026-03-10', value: 20, min: 5, max: 40, n: 2 },
      { day: '2026-03-17', value: 30, min: 3, max: 33, n: 1 },
    ];
    expect(aggregatePoints(rows, 'week', 1, 'sum')).toEqual([
      { key: '2026-03-09', value: 30, min: null, max: null, n: 6, days: 2 },
      { key: '2026-03-16', value: 30, min: null, max: null, n: 1, days: 1 },
    ]);
    expect(aggregatePoints(rows, 'month', 1, 'avg')).toEqual([{ key: '2026-03-01', value: 20, min: 1, max: 40, n: 7, days: 3 }]);
    expect(aggregatePoints(rows, 'day', 1, 'avg').map((p) => p.value)).toEqual([10, 20, 30]);
    expect(summarize(rows, 'avg')).toMatchObject({
      days: 3,
      samples: 7,
      min: 1,
      max: 40,
      mean: 20,
      median: 20,
      total: null,
      latest: 30,
      latestDay: '2026-03-17',
      firstDay: '2026-03-09',
    });
    expect(summarize(rows, 'sum')).toMatchObject({ min: 10, max: 30, total: 60 });
    expect(summarize([], 'sum')).toMatchObject({ days: 0, mean: null, latest: null });
  });

  it('combines category values per day without double counting InBed and Awake of sleep', () => {
    const by = new Map([
      ['InBed', [{ day: '2026-03-10', value: 480, min: null, max: null, n: 1 }]],
      ['AsleepCore', [{ day: '2026-03-10', value: 300, min: null, max: null, n: 10 }]],
      ['AsleepDeep', [{ day: '2026-03-10', value: 60, min: null, max: null, n: 5 }]],
      ['Awake', [{ day: '2026-03-10', value: 20, min: null, max: null, n: 3 }]],
    ]);
    expect(combineCategoryRows(by, 'HKCategoryTypeIdentifierSleepAnalysis')).toEqual([
      { day: '2026-03-10', value: 360, min: null, max: null, n: 15 },
    ]);
    expect(combineCategoryRows(by, 'HKCategoryTypeIdentifierMindfulSession')[0]!.value).toBe(860);
  });
});

describe('metric series endpoint', () => {
  it('serves a metric as daily, weekly and monthly series with statistics', async () => {
    for (let i = 0; i < 40; i++) {
      const day = addDays('2026-03-30', -i);
      fx.daily('HKQuantityTypeIdentifierStepCount', day, 10_000 + i, { n: 20 });
      fx.daily('HKQuantityTypeIdentifierBodyMass', day, 75 + (i % 3), { min: 74.5, max: 78, n: 2 });
    }
    fx.rec(fx.T.steps!, '2026-03-30T10:00:00+02:00', '2026-03-30T10:05:00+02:00', { value: 100, tz: 120 });
    fx.refreshStats();

    const month = await get<MetricSeries>('/api/health/metric/series?type=StepCount&agg=month&fromDay=2026-03-01&toDay=2026-03-30');
    expect(month.type).toMatchObject({ identifier: 'HKQuantityTypeIdentifierStepCount', aggregation: 'sum', kind: 'quantity', count: 1 });
    expect(month.points).toHaveLength(1);
    expect(month.points[0]).toMatchObject({ key: '2026-03-01', days: 30, n: 600 });
    const expectedTotal = Array.from({ length: 30 }, (_, i) => 10_000 + i).reduce((a, b) => a + b, 0);
    expect(month.points[0]!.value).toBe(expectedTotal);
    expect(month.stats).toMatchObject({ days: 30, total: expectedTotal, min: 10_000, max: 10_029, latest: 10_000, latestDay: '2026-03-30' });
    expect(month.categories).toEqual([]);

    const week = await get<MetricSeries>('/api/health/metric/series?type=StepCount&agg=week&fromDay=2026-03-09&toDay=2026-03-22');
    expect(week.points.map((p) => p.key)).toEqual(['2026-03-09', '2026-03-16']); // Monday weeks by default
    expect(week.points.every((p) => p.days === 7)).toBe(true);

    const avg = await get<MetricSeries>('/api/health/metric/series?type=BodyMass&agg=month&fromDay=2026-03-01&toDay=2026-03-30');
    expect(avg.points[0]).toMatchObject({ min: 74.5, max: 78, days: 30 });
    expect(avg.stats.total).toBeNull();

    // the week start follows the athlete's setting
    await fx.app.inject({ method: 'PATCH', url: '/api/settings', payload: { weekStart: 0 } });
    const sunday = await get<MetricSeries>('/api/health/metric/series?type=StepCount&agg=week&fromDay=2026-03-08&toDay=2026-03-14');
    expect(sunday.points[0]!.key).toBe('2026-03-08');
    await fx.app.inject({ method: 'PATCH', url: '/api/settings', payload: { weekStart: 1 } });

    expect((await fx.app.inject({ url: '/api/health/metric/series?type=StepCount&agg=year' })).statusCode).toBe(400);
    expect((await fx.app.inject({ url: '/api/health/metric/series?type=DoesNotExist' })).statusCode).toBe(404);
  });

  it('serves category types stacked by value', async () => {
    fx.daily('HKCategoryTypeIdentifierSleepAnalysis:AsleepCore', '2026-03-29', 300);
    fx.daily('HKCategoryTypeIdentifierSleepAnalysis:AsleepDeep', '2026-03-29', 80);
    fx.daily('HKCategoryTypeIdentifierSleepAnalysis:InBed', '2026-03-29', 500);
    fx.daily('HKCategoryTypeIdentifierSleepAnalysis:AsleepCore', '2026-03-30', 320);
    const r = await get<MetricSeries>('/api/health/metric/series?type=SleepAnalysis&fromDay=2026-03-28');
    expect(r.categories.map((c) => c.value)).toEqual(['AsleepCore', 'InBed', 'AsleepDeep']); // by total, descending
    expect(r.categories[0]).toMatchObject({ total: 620 });
    expect(r.points.map((p) => p.value)).toEqual([380, 320]); // InBed is not added to the stages
    expect(r.stats).toMatchObject({ days: 2, total: 700 });
  });
});

describe('metric sources and samples endpoints', () => {
  it('lists sources with devices and paginates raw samples with exact local-day filtering', async () => {
    for (let i = 0; i < 25; i++) {
      const iso = `2026-03-${String(1 + (i % 5)).padStart(2, '0')}T0${i % 10}:15:00+01:00`;
      fx.rec(fx.T.weight!, iso, iso, { value: 75 + i / 10, source: SRC.scale });
    }
    fx.rec(fx.T.weight!, '2026-03-05T23:30:00+01:00', '2026-03-05T23:30:00+01:00', { value: 80, source: SRC.phone });
    fx.refreshStats();

    const src = await get<MetricSources>('/api/health/metric/sources?type=BodyMass');
    expect(src.total).toBe(26);
    expect(src.sources.map((s) => [s.name, s.count])).toEqual([
      ['Withings', 25],
      ['iPhone von Hannes', 1],
    ]);
    const ranged = await get<MetricSources>('/api/health/metric/sources?type=BodyMass&fromDay=2026-03-05&toDay=2026-03-05');
    expect(ranged.total).toBeLessThan(26);
    expect(ranged.sources.some((s) => s.name === 'iPhone von Hannes')).toBe(true);

    const page1 = await get<Page<MetricSample>>('/api/health/metric/samples?type=BodyMass&limit=10');
    expect(page1).toMatchObject({ total: 26, limit: 10, offset: 0 });
    expect(page1.items).toHaveLength(10);
    expect(page1.items[0]!.value).toBe(80); // newest first: 2026-03-05 23:30
    expect(page1.items[0]!.source).toBe('iPhone von Hannes');
    const page3 = await get<Page<MetricSample>>('/api/health/metric/samples?type=BodyMass&limit=10&offset=20');
    expect(page3.items).toHaveLength(6);
    const asc = await get<Page<MetricSample>>('/api/health/metric/samples?type=BodyMass&limit=2&order=asc');
    expect(asc.items[0]!.startTs).toBeLessThanOrEqual(asc.items[1]!.startTs);
    // local-day filter: only samples of the 5th (the late one is still the 5th locally)
    const day5 = await get<Page<MetricSample>>('/api/health/metric/samples?type=BodyMass&fromDay=2026-03-05&toDay=2026-03-05&limit=100');
    expect(day5.total).toBe(day5.items.length);
    expect(day5.items.every((x) => new Date((x.startTs + x.tzMin * 60) * 1000).toISOString().startsWith('2026-03-05'))).toBe(true);
    expect(day5.items.some((x) => x.value === 80)).toBe(true);
    expect((await fx.app.inject({ url: '/api/health/metric/samples?type=BodyMass&limit=9999' })).statusCode).toBe(400);
  });
});

describe('explorer and body endpoints', () => {
  it('lists every record type with a sparkline and counts of the other items', async () => {
    run(fx.db, "INSERT INTO ecg_readings (athlete_id, recorded_ts, tz_min, classification, sample_rate_hz) VALUES (1, ?, 60, 'Sinus Rhythm', 512)", [
      ts('2026-03-01T10:00:00+01:00'),
    ]);
    run(
      fx.db,
      `INSERT INTO correlations (athlete_id, type, start_ts, end_ts, tz_min, source_id, items)
       VALUES (1, 'HKCorrelationTypeIdentifierBloodPressure', ?, ?, 60, 3, ?)`,
      [
        ts('2026-03-02T08:00:00+01:00'),
        ts('2026-03-02T08:00:00+01:00'),
        JSON.stringify([
          { type: 'HKQuantityTypeIdentifierBloodPressureSystolic', value: 121, unit: 'mmHg', text: null },
          { type: 'HKQuantityTypeIdentifierBloodPressureDiastolic', value: 79, unit: 'mmHg', text: null },
        ]),
      ],
    );
    run(fx.db, "INSERT INTO health_items (athlete_id, kind, start_ts, hash, data) VALUES (1, 'Audiogram', ?, 1, '{}'), (1, 'Me', NULL, 2, '{}')", [
      ts('2026-02-01T10:00:00+01:00'),
    ]);
    run(fx.db, "INSERT INTO activity_summaries (athlete_id, day, active_energy_kcal) VALUES (1, '2026-03-01', 500), (1, '2026-03-02', 510)");
    fx.refreshStats();
    const ex = await get<ExplorerResponse>('/api/health/explorer');
    const steps = ex.types.find((t) => t.identifier === 'HKQuantityTypeIdentifierStepCount')!;
    expect(steps.spark).toHaveLength(90);
    expect(steps.aggregation).toBe('sum');
    expect(steps.count).toBeGreaterThan(0);
    const keys = Object.fromEntries(ex.items.map((i) => [i.key, i.count]));
    expect(keys).toMatchObject({ ecg: 1, correlations: 1, audiogram: 1, activitySummaries: 2 });
    expect(keys['other:Me']).toBeUndefined(); // the profile is not a data item
    const sleep = ex.types.find((t) => t.identifier === 'HKCategoryTypeIdentifierSleepAnalysis');
    // (no sleep records here, so the type is not listed: only types with records appear)
    expect(sleep).toBeUndefined();
  });

  it('reads blood pressure from correlations, and from paired records without them', async () => {
    const r = await get<BloodPressureReading[]>('/api/health/body/blood-pressure');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ systolic: 121, diastolic: 79, day: '2026-03-02', source: 'Withings', pulse: null });
    expect(await get<BloodPressureReading[]>('/api/health/body/blood-pressure?fromDay=2026-04-01')).toEqual([]);
    run(fx.db, 'DELETE FROM correlations');
    fx.rec(fx.T.bpSys!, '2026-03-03T07:00:00+01:00', '2026-03-03T07:00:00+01:00', { value: 130, source: SRC.scale });
    fx.rec(fx.T.bpDia!, '2026-03-03T07:00:00+01:00', '2026-03-03T07:00:00+01:00', { value: 85, source: SRC.scale });
    fx.rec(fx.T.bpSys!, '2026-03-04T07:00:00+01:00', '2026-03-04T07:00:00+01:00', { value: 140, source: SRC.scale }); // unpaired
    const fb = await get<BloodPressureReading[]>('/api/health/body/blood-pressure');
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ systolic: 130, diastolic: 85, day: '2026-03-03' });
  });
});
