import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { all, openDb, run, type Db } from '../src/db/db';
import { DERIVE_VERSION } from '../src/derive/context';
import { listActivities, listWhere, orderBy } from '../src/features/activities/queries';

let db: Db;
const ids: Record<string, number> = {};

beforeAll(() => {
  db = openDb(':memory:');
  migrateAll(db);
  const T0 = Date.UTC(2026, 2, 1, 8) / 1000;
  // name, day, distance (null = none)
  const rows: [string, number, number | null][] = [
    ['a', 0, 5000],
    ['b', 1, null],
    ['c', 2, 8000],
    ['d', 2, 5000], // same start as c
    ['e', 3, null],
  ];
  for (const [name, day, dist] of rows)
    ids[name] = run(
      db,
      `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, name, start_ts, end_ts, tz_min, duration_s,
         distance_m, derived_version)
       VALUES (1, ?, 'HKWorkoutActivityTypeRunning', 'run', ?, ?, ?, 60, 1800, ?, ?)`,
      [name, name, T0 + day * 86400, T0 + day * 86400 + 1800, dist, DERIVE_VERSION],
    ).lastInsertRowid;
});

afterAll(() => db?.close());

const order = (sort: 'start' | 'distance', dir: 'asc' | 'desc') =>
  listActivities(db, 1, { sort, order: dir, limit: 20, offset: 0 }).items.map((x) => x.name);

describe('activity list order', () => {
  it('sorts by start, then id', () => {
    expect(order('start', 'desc')).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(order('start', 'asc')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps activities without a value last in both directions', () => {
    expect(order('distance', 'desc')).toEqual(['c', 'd', 'a', 'e', 'b']);
    expect(order('distance', 'asc')).toEqual(['a', 'd', 'c', 'b', 'e']);
  });

  it('reads the default order from the start index instead of sorting every activity', () => {
    for (const dir of ['desc', 'asc'] as const) {
      const { sql, params } = listWhere(1, {});
      const plan = all<{ detail: string }>(
        db,
        `EXPLAIN QUERY PLAN SELECT id FROM workouts WHERE ${sql} ORDER BY ${orderBy('start', dir)} LIMIT 20`,
        params,
      ).map((r) => r.detail);
      expect(plan.join(' | ')).toContain('ix_workouts_start');
      expect(plan.join(' | ')).not.toContain('TEMP B-TREE');
    }
    expect(ids.a).toBeLessThan(ids.e!);
  });
});
