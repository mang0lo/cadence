import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APPLE_HEART_METRICS, DEVICE_HEART_METRICS, HK, metricDef, periodKeys, periodStart } from '@cadence/shared';
import { migrateAll } from '../src/app';
import { updateSettings } from '../src/core/settings';
import { heartMetric } from '../src/core/sources';
import { openDb, run, type Db } from '../src/db/db';
import { aggregatePoints, periodStart as seriesPeriodStart } from '../src/features/health/series';

/**
 * HealthKit identifiers, the heart metrics a watch can replace and the period helpers of the health charts live in
 * @cadence/shared, so the server and the web read the same keys and periods.
 */
let db: Db;

beforeAll(() => {
  db = openDb(':memory:');
  migrateAll(db);
});

afterAll(() => db?.close());

describe('heart metric keys', () => {
  it('are catalogued identifiers for Apple and the watch keys for the device', () => {
    for (const id of Object.values(HK)) expect(metricDef(id), id).toBeTruthy();
    for (const id of Object.values(APPLE_HEART_METRICS)) expect(id.startsWith('HK'), id).toBe(true);
    for (const id of Object.values(DEVICE_HEART_METRICS)) expect(id.startsWith('COROS'), id).toBe(true);
    expect(Object.keys(DEVICE_HEART_METRICS).sort()).toEqual(Object.keys(APPLE_HEART_METRICS).sort());
    expect(APPLE_HEART_METRICS.restingHr).toBe(HK.restingHr);
  });

  it('are what the server reads for the preferred source', () => {
    updateSettings(db, 1, { watch: 'apple', sources: { workouts: 'auto', heart: 'auto' } });
    for (const [k, id] of Object.entries(APPLE_HEART_METRICS)) expect(heartMetric(db, 1, k as keyof typeof APPLE_HEART_METRICS)).toBe(id);
    updateSettings(db, 1, { watch: 'coros' });
    for (const [k, id] of Object.entries(DEVICE_HEART_METRICS)) expect(heartMetric(db, 1, k as keyof typeof DEVICE_HEART_METRICS)).toBe(id);
    // the other source when the preferred one has no data
    run(db, "INSERT INTO daily_metrics (athlete_id, metric, day, value) VALUES (1, ?, '2026-03-01', 50)", [APPLE_HEART_METRICS.restingHr]);
    expect(heartMetric(db, 1, 'restingHr')).toBe(APPLE_HEART_METRICS.restingHr);
  });
});

describe('periods of the health charts', () => {
  it('starts days, weeks and months', () => {
    expect(periodStart('2026-03-15', 'week', 1)).toBe('2026-03-09');
    expect(periodStart('2026-03-15', 'week', 0)).toBe('2026-03-15');
    expect(periodStart('2026-03-01', 'week', 1)).toBe('2026-02-23');
    expect(periodStart('2026-03-15', 'month', 1)).toBe('2026-03-01');
    expect(periodStart('2026-03-15', 'day', 1)).toBe('2026-03-15');
    expect(seriesPeriodStart).toBe(periodStart);
  });

  it('lists every period of a range, also those without data', () => {
    expect(periodKeys('2025-12-30', '2026-01-02', 'day', 1)).toEqual(['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']);
    expect(periodKeys('2025-12-03', '2025-12-24', 'week', 1)).toEqual(['2025-12-01', '2025-12-08', '2025-12-15', '2025-12-22']);
    expect(periodKeys('2025-12-03', '2025-12-24', 'week', 0)).toEqual(['2025-11-30', '2025-12-07', '2025-12-14', '2025-12-21']);
    expect(periodKeys('2025-10-15', '2026-02-01', 'month', 1)).toEqual(['2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01']);
    expect(periodKeys('2026-01-02', '2025-12-30', 'day', 1)).toEqual([]);
  });

  it('keys the server series by the same periods', () => {
    const rows = [
      { day: '2026-03-02', value: 10, min: null, max: null, n: 1 },
      { day: '2026-03-20', value: 20, min: null, max: null, n: 1 },
    ];
    const keys = periodKeys('2026-03-01', '2026-03-31', 'week', 1);
    for (const p of aggregatePoints(rows, 'week', 1, 'sum')) expect(keys).toContain(p.key);
  });
});
