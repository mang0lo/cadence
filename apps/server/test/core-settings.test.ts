import { DEFAULT_SETTINGS } from '@cadence/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { getSetting, getSettings, updateSettings } from '../src/core/settings';
import { openDb, type Db } from '../src/db/db';

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
