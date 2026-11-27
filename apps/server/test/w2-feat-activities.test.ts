import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { openDb, run, type Db } from '../src/db/db';
import { DERIVE_VERSION } from '../src/derive/context';
import { bestEffortsOf } from '../src/core/workouts';
import { medalsFor } from '../src/features/activities/queries';
import { parseDay } from '../src/lib/time';

let db: Db;

beforeAll(() => {
  db = openDb(':memory:');
  migrateAll(db);
});

afterAll(() => db?.close());

beforeEach(() => {
  run(db, 'DELETE FROM best_efforts');
  run(db, 'DELETE FROM workouts');
});

let ext = 0;

/** A run starting at local `day` + `hour` (UTC offset `tzMin`) with best efforts { effort: elapsed seconds }. */
function runOn(
  day: string,
  efforts: Record<string, number> = {},
  o: { hour?: number; tzMin?: number; hidden?: boolean; distanceM?: number } = {},
): number {
  const tzMin = o.tzMin ?? 60;
  const start = parseDay(day)! * 86400 + (o.hour ?? 8) * 3600 - tzMin * 60;
  const { lastInsertRowid: id } = run(
    db,
    `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, hidden,
       distance_m, derived_version)
     VALUES (1, ?, 'HKWorkoutActivityTypeRunning', 'run', ?, ?, ?, 3600, ?, ?, ?)`,
    [`k${ext++}`, start, start + 3600, tzMin, o.hidden ? 1 : 0, o.distanceM ?? null, DERIVE_VERSION],
  );
  for (const [effort, elapsed] of Object.entries(efforts))
    run(
      db,
      `INSERT INTO best_efforts (athlete_id, workout_id, sport, effort, distance_m, elapsed_s, start_offset_s, start_ts)
       VALUES (1, ?, 'run', ?, 5000, ?, 0, ?)`,
      [id, effort, elapsed, start],
    );
  return id;
}

const detailRank = (id: number, effort: string) =>
  bestEffortsOf(db, { id, hidden: 0, duplicate_of: null }).find((e) => e.effort === effort)?.rank ?? null;

describe('best effort ranks on the activity page', () => {
  it('give a tie to the earlier attempt like the medals, whatever the import order', () => {
    const later = runOn('2026-03-10', { '5k': 1500 }); // imported first, run later
    const earlier = runOn('2026-03-01', { '5k': 1500 }); // imported later, run earlier
    const slower = runOn('2026-02-01', { '5k': 1600 });
    expect(later).toBeLessThan(earlier);
    expect(detailRank(earlier, '5k')).toBe(1);
    expect(detailRank(later, '5k')).toBe(2);
    expect(detailRank(slower, '5k')).toBe(3);
    const medals = medalsFor(db, 1, [later, earlier, slower]);
    for (const id of [later, earlier, slower]) expect(medals.get(id)?.[0]?.rank ?? null).toBe(detailRank(id, '5k'));
  });

  it('keeps the id as the last tie breaker for attempts with the same start', () => {
    const a = runOn('2026-03-01', { '5k': 1500 });
    const b = runOn('2026-03-01', { '5k': 1500 });
    expect(detailRank(a, '5k')).toBe(1);
    expect(detailRank(b, '5k')).toBe(2);
  });
});
