import { DEFAULT_SETTINGS } from '@cadence/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { getEffectiveHr, getSetting, getSettings, updateSettings } from '../src/core/settings';
import { openDb, run, type Db } from '../src/db/db';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
  migrateAll(db);
});

afterEach(() => db.close());

const stored = () => getSetting<Record<string, unknown>>(db, 1, 'core.settings', {});

describe('settings', () => {
  it('stores only what the athlete changed, so defaults stay defaults', () => {
    const next = updateSettings(db, 1, { theme: 'dark' });
    expect(next).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' });
    expect(stored()).toEqual({ theme: 'dark' });
    // "the athlete never chose a watch" (first COROS connection makes COROS the watch) still holds
    expect('watch' in stored()).toBe(false);
    updateSettings(db, 1, { units: 'imperial', watch: 'apple' });
    expect(stored()).toEqual({ theme: 'dark', units: 'imperial', watch: 'apple' });
    expect(getSettings(db, 1)).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark', units: 'imperial', watch: 'apple' });
  });

  it('keeps values of earlier versions that stored every key', () => {
    updateSettings(db, 1, { ...DEFAULT_SETTINGS, maxHr: 182 });
    expect(updateSettings(db, 1, { theme: 'light' })).toEqual({ ...DEFAULT_SETTINGS, maxHr: 182, theme: 'light' });
  });
});

describe('effective heart rate', () => {
  const workout = (n: number, maxHr: number, hidden = 0) =>
    run(
      db,
      `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, duration_s, max_hr, hidden)
       VALUES (1, ?, 'HKWorkoutActivityTypeRunning', 'run', ?, ?, 1800, ?, ?)`,
      [`w${n}`, 1_700_000_000 + n * 86_400, 1_700_001_800 + n * 86_400, maxHr, hidden],
    );

  it('observes the max HR in workouts that count, not in hidden ones (sensor spikes are a reason to hide)', () => {
    [180, 182, 184, 185].forEach((hr, i) => workout(i, hr));
    expect(getEffectiveHr(db, 1)).toMatchObject({ maxHr: 182, maxHrSource: 'observed' });
    [210, 215, 220].forEach((hr, i) => workout(10 + i, hr, 1));
    expect(getEffectiveHr(db, 1)).toMatchObject({ maxHr: 182, maxHrSource: 'observed' });
  });
});
