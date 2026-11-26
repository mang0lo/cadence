import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { all, run } from '../src/db/db';
import { addDays } from '../src/lib/time';
import { rebuildSleepNights } from '../src/features/health/sleep';
import { createHealthFixture, type HealthFixture } from './health-fixture';

/**
 * Days with an Apple Watch night and a COROS night: the heart source preference (Settings → My watch) decides which
 * one the sleep pages and readiness use. Changing it must switch every night, not only the last few days.
 */
let fx: HealthFixture;
const FIRST = '2026-03-01'; // wake days 2026-03-01 … 2026-03-10
const NIGHTS = 10;
const WATCH = 'Apple Watch von Hannes';

const sources = () =>
  all<{ day: string; source: string | null }>(fx.db, "SELECT day, source FROM health_sleep_nights WHERE kind = 'night' ORDER BY day").map(
    (r) => r.source,
  );

async function setHeartSource(heart: 'apple' | 'device'): Promise<void> {
  const res = await fx.app.inject({ method: 'PATCH', url: '/api/settings', payload: { sources: { workouts: 'auto', heart } } });
  expect(res.statusCode, res.body).toBe(200);
  // the settings change recomputes derived data in a background job (inline in tests): wait for it
  for (let i = 0; i < 500 && fx.app.jobs.busy(1); i++) await new Promise((r) => setTimeout(r, 10));
  expect(fx.app.jobs.busy(1)).toBe(false);
}

beforeAll(async () => {
  fx = await createHealthFixture();
  fx.T.sleep = fx.addType(1, 'HKCategoryTypeIdentifierSleepAnalysis', 'category', null, 'duration');
  for (let i = 0; i < NIGHTS; i++) {
    const wake = addDays(FIRST, i);
    fx.rec(fx.T.sleep, `${addDays(wake, -1)}T23:00:00+01:00`, `${wake}T03:00:00+01:00`, { text: 'AsleepCore' });
    fx.rec(fx.T.sleep, `${wake}T03:00:00+01:00`, `${wake}T06:30:00+01:00`, { text: 'AsleepDeep' });
    run(
      fx.db,
      `INSERT INTO health_external_nights (athlete_id, source, day, asleep_s, deep_s, light_s, rem_s, awake_s)
       VALUES (1, 'COROS', ?, ?, 3600, 18000, 3600, 600)`,
      [wake, 25_200],
    );
  }
  fx.refreshStats();
  rebuildSleepNights(fx.db, 1, null);
}, 60_000);

afterAll(async () => {
  await fx?.close();
});

describe('sleep nights follow the heart source preference', () => {
  it("keeps Apple's nights while Apple is preferred", () => {
    expect(sources()).toEqual(Array(NIGHTS).fill(WATCH));
  });

  it("switches every night to the watch's own nights, and back", async () => {
    await setHeartSource('device');
    expect(sources()).toEqual(Array(NIGHTS).fill('COROS'));
    await setHeartSource('apple');
    expect(sources()).toEqual(Array(NIGHTS).fill(WATCH));
  });

  it('rebuilds only the recent nights while the preference stays the same', () => {
    run(fx.db, "UPDATE health_sleep_nights SET source = 'stale' WHERE day = ?", [FIRST]);
    rebuildSleepNights(fx.db, 1, addDays(FIRST, NIGHTS - 1));
    expect(sources()[0]).toBe('stale');
    expect(sources()[NIGHTS - 1]).toBe(WATCH);
  });

  it('rebuilds every night once when it is not known which preference built them', () => {
    run(fx.db, "DELETE FROM settings WHERE key = 'health.sleepNightsSource'");
    rebuildSleepNights(fx.db, 1, addDays(FIRST, NIGHTS - 1));
    expect(sources()).toEqual(Array(NIGHTS).fill(WATCH));
  });
});
