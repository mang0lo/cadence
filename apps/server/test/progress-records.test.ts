import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { updateSettings } from '../src/core/settings';
import { openDb, run, type Db } from '../src/db/db';
import { zSport } from '../src/features/progress/common';
import { effortHistory, predictions, recentVo2max, records } from '../src/features/progress/records';

let db: Db;

beforeAll(() => {
  db = openDb(':memory:');
  migrateAll(db);
});

afterAll(() => db?.close());

beforeEach(() => {
  run(db, 'DELETE FROM daily_metrics');
  updateSettings(db, 1, { watch: 'apple', sources: { workouts: 'auto', heart: 'auto' } });
});

const metric = (name: string, day: string, value: number) =>
  run(db, 'INSERT INTO daily_metrics (athlete_id, metric, day, value) VALUES (1, ?, ?, ?)', [name, day, value]);

describe('race predictor VO2max', () => {
  it("uses the preferred source's VO2max (COROS for a COROS watch)", () => {
    metric('HKQuantityTypeIdentifierVO2Max', '2026-03-01', 44);
    metric('COROSVO2Max', '2026-03-02', 52);
    expect(recentVo2max(db, 1, '2026-03-10')).toEqual({ value: 44, day: '2026-03-01' });
    updateSettings(db, 1, { watch: 'coros' });
    expect(recentVo2max(db, 1, '2026-03-10')).toEqual({ value: 52, day: '2026-03-02' });
    expect(predictions(db, 1, '2026-03-10').vo2max).toEqual({ value: 52, day: '2026-03-02' });
  });

  it('COROS-only athletes get VO2max predictions', () => {
    updateSettings(db, 1, { watch: 'coros' });
    metric('COROSVO2Max', '2026-03-02', 50);
    const p = predictions(db, 1, '2026-03-10');
    expect(p.vo2max?.value).toBe(50);
    expect(p.targets.every((t) => t.vo2max !== null && t.vo2max.elapsedS > 0)).toBe(true);
  });

  it('an implausible latest reading does not anchor the window', () => {
    metric('HKQuantityTypeIdentifierVO2Max', '2026-01-10', 45);
    metric('HKQuantityTypeIdentifierVO2Max', '2026-03-05', 3);
    expect(recentVo2max(db, 1, '2026-03-10')).toEqual({ value: 45, day: '2026-01-10' });
  });
});

describe('sport validation', () => {
  it('rejects inherited object keys with 400 instead of failing with 500', () => {
    for (const s of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])
      expect(zSport.safeParse(s).success, s).toBe(false);
    expect(zSport.parse('run')).toBe('run');
    expect(zSport.parse('all')).toBeNull();
    expect(records(db, 1, { sport: 'constructor', today: '2026-03-10' }).efforts).toEqual([]);
    expect(effortHistory(db, 1, { sport: 'toString', effort: '5k' })).toBeNull();
  });
});
