import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthMetricCard, HealthOverview, HealthSnapshot } from '@cadence/shared';
import { run } from '../src/db/db';
import { addDays } from '../src/lib/time';
import { createHealthFixture, type HealthFixture } from './health-fixture';

/**
 * Overview cards of cumulative metrics (steps, energy, mindful minutes …) count days without a record as 0, so they
 * must end where their own source's data ends: an Apple Health export does not cover the days a COROS sync adds after
 * it, and the day the export was taken holds only its morning.
 */
let fx: HealthFixture;
const D = '2026-03-30'; // last full day of the Apple Health export
const STEPS = 'HKQuantityTypeIdentifierStepCount';
const ENERGY = 'HKQuantityTypeIdentifierActiveEnergyBurned';
const MINDFUL = 'HKCategoryTypeIdentifierMindfulSession:NotApplicable';

const card = async (key: string): Promise<HealthMetricCard> =>
  (await fx.getJson<HealthOverview>('/api/health/overview')).cards.find((c) => c.key === key)!;

beforeAll(async () => {
  fx = await createHealthFixture();
  fx.T.steps = fx.addType(1, STEPS, 'quantity', 'count', 'sum');
  fx.T.energy = fx.addType(2, ENERGY, 'quantity', 'kcal', 'sum');
  fx.T.mindful = fx.addType(3, 'HKCategoryTypeIdentifierMindfulSession', 'category', null, 'duration');
  fx.T.rhr = fx.addType(4, 'HKQuantityTypeIdentifierRestingHeartRate', 'quantity', 'count/min', 'avg');
  fx.T.coros = fx.addType(5, 'COROSRestingHeartRate', 'quantity', 'count/min', 'avg');
  // 60 days of Apple data up to D: 10,000 steps a day in the last 30 days, 8,000 before; resting HR every day
  for (let i = 0; i < 60; i++) {
    const day = addDays(D, -i);
    fx.daily(STEPS, day, i < 30 ? 10_000 : 8_000);
    fx.daily(ENERGY, day, i < 30 ? 600 : 500);
    fx.daily('HKQuantityTypeIdentifierRestingHeartRate', day, 52);
  }
  // sparse mindful minutes: the last session 10 days before the end of the export
  fx.daily(MINDFUL, addDays(D, -50), 10);
  fx.daily(MINDFUL, addDays(D, -20), 15);
  fx.daily(MINDFUL, addDays(D, -10), 15);
  // the export reaches into the last hour of D (+01:00)
  fx.rec(fx.T.steps!, `${D}T23:40:00+01:00`, `${D}T23:45:00+01:00`, { value: 20 });
  fx.rec(fx.T.rhr!, `${D}T07:00:00+01:00`, `${D}T07:00:00+01:00`, { value: 52 });
  fx.refreshStats();
}, 60_000);

afterAll(async () => {
  await fx?.close();
});

describe('health overview: windows of cumulative metrics', () => {
  it('ends at the last complete day of an Apple-only export', async () => {
    const o = await fx.getJson<HealthOverview>('/api/health/overview');
    expect(o.asOf).toBe(D);
    expect(await card('steps')).toMatchObject({ latestDay: D, latest: 10_000, avg30: 10_000, n30: 30, avgPrev30: 8_000, nPrev30: 30 });
  });

  it('keeps the Apple cards on the export while a COROS sync moves asOf on', async () => {
    const later = addDays(D, 15);
    fx.rec(fx.T.coros!, `${later}T12:00:00Z`, `${later}T12:00:00Z`, { value: 48, tz: 0 });
    fx.refreshStats();
    const o = await fx.getJson<HealthOverview>('/api/health/overview');
    expect(o.asOf).toBe(later);
    // no zeros for the 15 days after the export: two full windows of Apple data stay comparable
    expect(await card('steps')).toMatchObject({ latestDay: D, avg30: 10_000, n30: 30, avgPrev30: 8_000 });
    const energy = await card('activeEnergy');
    expect(energy).toMatchObject({ latestDay: D, avg30: 600, avgPrev30: 500 });
    expect(energy.spark[energy.spark.length - 1]).toBe(600);
    // a sparse metric still counts the empty days inside the export (here 10 days after the last session)
    expect(await card('mindful')).toMatchObject({ latestDay: addDays(D, -10), n30: 30 });
    expect((await card('mindful')).avg30).toBeCloseTo(30 / 30, 9);
    // discrete metrics are not zero-filled and keep the global window
    expect(await card('restingHr')).toMatchObject({ latestDay: D, n30: 15 });
    run(fx.db, 'DELETE FROM records WHERE type_id = ?', [fx.T.coros!]);
    fx.refreshStats();
  });

  it('leaves out the partial day an export was taken on, whatever day it is today', async () => {
    const next = addDays(D, 1);
    fx.daily(STEPS, next, 1_500);
    fx.rec(fx.T.steps!, `${next}T07:55:00+01:00`, `${next}T08:00:00+01:00`, { value: 30 });
    fx.refreshStats();
    const o = await fx.getJson<HealthOverview>('/api/health/overview');
    expect(o.asOf).toBe(next);
    expect(await card('steps')).toMatchObject({ latestDay: D, latest: 10_000, avg30: 10_000, n30: 30 });
    // the dashboard snapshot as well
    const snap = await fx.getJson<HealthSnapshot>('/api/health/snapshot');
    expect(snap.asOf).toBe(next);
    expect(snap.steps).toMatchObject({ day: D, value: 10_000 });
    expect(snap.steps!.spark[13]).toBe(10_000);
    // the time of the export says the same when the export day has no records at all
    run(fx.db, 'DELETE FROM records WHERE type_id = ? AND start_ts > ?', [fx.T.steps!, Date.parse(`${D}T23:50:00+01:00`) / 1000]);
    run(fx.db, "DELETE FROM daily_metrics WHERE metric = ? AND day = ?", [STEPS, next]);
    run(
      fx.db,
      `INSERT INTO import_jobs (id, athlete_id, kind, status, stats, finished_at) VALUES ('j1', 1, 'import', 'done', ?, 1)`,
      [JSON.stringify({ exportDate: `${next} 08:00:00 +0100` })],
    );
    fx.refreshStats();
    expect(await card('steps')).toMatchObject({ latestDay: D, avg30: 10_000, n30: 30 });
  });
});
