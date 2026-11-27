import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { openDb, run, type Db } from '../src/db/db';
import { refreshDailyActivity } from '../src/derive/daily';
import { loadDaily } from '../src/features/consistency/data';

let db: Db;
let ext = 0;
function addWorkout(iso: string, tzMin: number, sport: string, distanceM: number, o: { hidden?: boolean } = {}) {
  const start = Date.parse(iso) / 1000;
  run(
    db,
    `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, distance_m, hidden)
     VALUES (1, ?, 'x', ?, ?, ?, ?, 1800, ?, ?)`,
    [`k${ext++}`, sport, start, start + 1800, tzMin, distanceM, o.hidden ? 1 : 0],
  );
}

beforeAll(() => {
  db = openDb(':memory:');
  migrateAll(db);
  // two runs on 10 June (local), one of them late in the evening at +10:00 (still the 10th locally, the 10th in UTC)
  addWorkout('2026-06-10T07:00:00+02:00', 120, 'run', 5_000);
  addWorkout('2026-06-10T23:30:00+10:00', 600, 'run', 12_000);
  // 11 June: a ride, and a run that starts on the 11th locally but on the 10th in UTC
  addWorkout('2026-06-11T01:00:00+02:00', 120, 'run', 8_000);
  addWorkout('2026-06-11T09:00:00+02:00', 120, 'ride', 40_000);
  // hidden: never the longest
  addWorkout('2026-06-11T12:00:00+02:00', 120, 'run', 42_195, { hidden: true });
  refreshDailyActivity(db, 1);
});

afterAll(() => db?.close());

describe('consistency loadDaily', () => {
  it('adds the longest visible activity of each local day and sport, with or without a range', () => {
    const all = loadDaily(db, 1);
    expect(all.map((r) => [r.day, r.sport, r.count, r.longestM])).toEqual([
      ['2026-06-10', 'run', 2, 12_000],
      ['2026-06-11', 'ride', 1, 40_000],
      ['2026-06-11', 'run', 1, 8_000],
    ]);
    expect(loadDaily(db, 1, '2026-06-11', '2026-06-11')).toEqual(all.slice(1));
    expect(loadDaily(db, 1, '2026-06-10', '2026-06-10')).toEqual(all.slice(0, 1));
    expect(loadDaily(db, 1, '2026-06-11')).toEqual(all.slice(1));
    expect(loadDaily(db, 1, '2026-06-12')).toEqual([]);
  });
});
