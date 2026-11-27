import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IntradayResponse } from '@cadence/shared';
import { localDay } from '../src/lib/time';
import { bucketize } from '../src/features/health/intraday';
import { createHealthFixture, ts, type HealthFixture } from './health-fixture';

/** The intraday view on days with two offsets (DST changes) and on days without samples. */
let fx: HealthFixture;
const intraday = (day: string, type = 'HeartRate', bucket = 5) =>
  fx.getJson<IntradayResponse>(`/api/health/intraday?type=${type}&day=${day}&bucket=${bucket}`);
/** Local wall-clock time of a bucket the way the web labels it: its own offset, else the day's. */
const label = (r: IntradayResponse, i: number) => {
  const b = r.buckets[i]!;
  const local = b.ts + (b.tzMin ?? r.tzMin) * 60;
  return new Date(local * 1000).toISOString().slice(11, 16);
};

beforeAll(async () => {
  fx = await createHealthFixture();
  fx.T.hr = fx.addType(1, 'HKQuantityTypeIdentifierHeartRate', 'quantity', 'count/min', 'avg');
  fx.T.steps = fx.addType(2, 'HKQuantityTypeIdentifierStepCount', 'quantity', 'count', 'sum');
  fx.T.spo2 = fx.addType(3, 'HKQuantityTypeIdentifierOxygenSaturation', 'quantity', '%', 'avg');
  const hr = (iso: string, value: number, tz: number) => fx.rec(fx.T.hr!, iso, iso, { value, tz });
  // Vienna, spring forward on 2026-03-29 at 02:00 (+01:00 → +02:00) and back on 2026-10-25 at 03:00
  hr('2026-03-29T01:30:00+01:00', 50, 60);
  hr('2026-03-29T03:30:00+02:00', 60, 120);
  hr('2026-03-29T12:00:00+02:00', 70, 120);
  hr('2026-10-25T01:30:00+02:00', 50, 120);
  hr('2026-10-25T02:30:00+01:00', 55, 60);
  // a trip to New York: the last samples before an empty day
  hr('2026-11-10T09:00:00-05:00', 65, -300);
  // steps only on one day, far from the days asked for below
  fx.rec(fx.T.steps!, '2026-06-01T10:00:00+10:00', '2026-06-01T10:05:00+10:00', { value: 300, tz: 600 });
  fx.refreshStats();
}, 60_000);

afterAll(async () => {
  await fx?.close();
});

describe('intraday view: offsets', () => {
  it('labels the buckets after the spring DST change with the summer offset', async () => {
    const r = await intraday('2026-03-29');
    expect(r).toMatchObject({ tzMin: 60, sampleCount: 3 });
    expect(r.dayStartTs).toBe(ts('2026-03-29T00:00:00+01:00'));
    expect(r.dayEndTs).toBe(ts('2026-03-30T00:00:00+02:00')); // a 23-hour day
    expect(r.buckets.map((b) => b.tzMin)).toEqual([undefined, 120, 120]);
    expect(r.buckets.map((_, i) => label(r, i))).toEqual(['01:30', '03:30', '12:00']);
  });

  it('labels the buckets after the autumn DST change with the winter offset', async () => {
    const r = await intraday('2026-10-25', 'HeartRate', 60);
    expect(r.tzMin).toBe(120);
    expect(r.dayEndTs - r.dayStartTs).toBe(25 * 3600);
    // 01:30 (+02:00) and the second 02:30 (+01:00) are two hours apart: two hourly buckets
    expect(r.buckets.map((_, i) => label(r, i))).toEqual(['01:00', '02:00']);
    expect(r.buckets[1]!.tzMin).toBe(60);
  });

  it("uses the offset of the type's nearest sample on a day without samples", async () => {
    expect((await intraday('2026-11-12')).tzMin).toBe(-300); // after the trip's last sample
    expect((await intraday('2026-01-05')).tzMin).toBe(60); // before the first sample: the first one after it
    const steps = await intraday('2026-06-03', 'StepCount', 60);
    expect(steps).toMatchObject({ tzMin: 600, buckets: [] });
    expect(steps.dayStartTs).toBe(ts('2026-06-03T00:00:00+10:00'));
    // a type without any sample keeps the server's offset
    expect((await intraday('2026-06-03', 'OxygenSaturation')).tzMin).toBe(-new Date().getTimezoneOffset());
  });

  it('marks only the buckets whose first sample has another offset (pure)', () => {
    const start = ts('2026-03-29T00:00:00+01:00');
    const rows = [
      { start_ts: ts('2026-03-29T01:10:00+01:00'), tz_min: 60, value: 1, source_id: 1 },
      { start_ts: ts('2026-03-29T03:10:00+02:00'), tz_min: 120, value: 2, source_id: 1 },
    ];
    const end = ts('2026-03-30T00:00:00+02:00');
    expect(bucketize(rows, start, end, 3600, 'sum', 60).map((b) => [localDay(b.ts + (b.tzMin ?? 60) * 60, 0), b.tzMin])).toEqual([
      ['2026-03-29', undefined],
      ['2026-03-29', 120],
    ]);
    expect(bucketize(rows, start, end, 3600, 'sum').every((b) => b.tzMin === undefined)).toBe(true);
  });
});
