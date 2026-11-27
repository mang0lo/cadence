import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityEfficiency } from '@cadence/shared';
import { migrateAll } from '../src/app';
import { openDb, run, type Db } from '../src/db/db';
import { DERIVE_VERSION } from '../src/derive/context';
import { similarActivities } from '../src/features/activities/queries';
import { ANALYSIS_VERSION } from '../src/features/activities/store';

let db: Db;

beforeAll(() => {
  db = openDb(':memory:');
  migrateAll(db);
});

afterAll(() => db?.close());

beforeEach(() => {
  run(db, 'DELETE FROM workouts');
  run(db, 'DELETE FROM maps_workout_geo');
});

let ext = 0;
const T0 = Date.UTC(2026, 0, 5, 7) / 1000;

interface AnalysisRow {
  efficiency: number | null;
  basis: ActivityEfficiency['basis'] | null;
  pace?: number | null;
  version?: number;
}

/** A visible 40 km ride on day `k` (1.5 h) with an analysis row of the given efficiency values (or none). */
function ride(k: number, a: AnalysisRow | null): number {
  const start = T0 + k * 86400;
  const { lastInsertRowid: id } = run(
    db,
    `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, moving_s,
       distance_m, avg_speed, avg_hr, derived_version)
     VALUES (1, ?, 'HKWorkoutActivityTypeCycling', 'ride', ?, ?, 60, 5400, 5400, 40000, ?, 140, ?)`,
    [`r${ext++}`, start, start + 5400, 40000 / 5400, DERIVE_VERSION],
  );
  if (a)
    run(
      db,
      `INSERT INTO activities_analysis (workout_id, athlete_id, cache_key, efficiency, efficiency_basis, pace_efficiency, data, computed_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, 0)`,
      [id, `${a.version ?? ANALYSIS_VERSION}|${DERIVE_VERSION}|0|-`, a.efficiency, a.basis, a.pace ?? null, new Uint8Array([0])],
    );
  return id;
}

describe('similar activities: efficiency factor', () => {
  it('never mixes W per bpm and m/min per bpm', () => {
    const p1 = ride(0, { efficiency: 1.5, basis: 'power', pace: 3.4 });
    const p2 = ride(1, { efficiency: 1.6, basis: 'power', pace: 3.5 });
    const s1 = ride(2, { efficiency: 3.3, basis: 'speed', pace: 3.3 });
    const s2 = ride(3, { efficiency: 3.2, basis: 'speed', pace: 3.2 });
    const ef = (id: number) => {
      const r = similarActivities(db, 1, id)!;
      return { basis: r.efficiencyBasis, values: Object.fromEntries(r.items.map((x) => [x.id, x.efficiency])) };
    };
    // a ride with power: only rides with power, in W per bpm
    expect(ef(p1)).toEqual({ basis: 'power', values: { [p1]: 1.5, [p2]: 1.6, [s1]: null, [s2]: null } });
    // a ride without power: the speed based value of every ride
    expect(ef(s1)).toEqual({ basis: 'speed', values: { [p1]: 3.4, [p2]: 3.5, [s1]: 3.3, [s2]: 3.2 } });
  });

  it('leaves out values of an older analysis and falls back to the most common basis', () => {
    const none = ride(0, { efficiency: null, basis: null });
    const old = ride(1, { efficiency: 1.4, basis: 'power', pace: 3.1, version: ANALYSIS_VERSION - 1 });
    const missing = ride(2, null);
    const p1 = ride(3, { efficiency: 1.5, basis: 'power', pace: 3.4 });
    const p2 = ride(4, { efficiency: 1.6, basis: 'power', pace: 3.5 });
    const s1 = ride(5, { efficiency: 3.3, basis: 'speed', pace: 3.3 });
    const r = similarActivities(db, 1, none)!;
    expect(r.efficiencyBasis).toBe('power');
    expect(Object.fromEntries(r.items.map((x) => [x.id, x.efficiency]))).toEqual({
      [none]: null,
      [old]: null,
      [missing]: null,
      [p1]: 1.5,
      [p2]: 1.6,
      [s1]: null,
    });
  });
});

/**
 * A visible 40 km ride on day `k` from (48.2, 16.4) to (48.21, 16.41) with the given moving time, on route
 * `routeId` of Maps → Routes (null = none, e.g. a track with breaks).
 */
function routeRide(k: number, routeId: number | null, movingS: number, o: { hidden?: boolean } = {}): number {
  const start = T0 + k * 86400;
  const { lastInsertRowid: id } = run(
    db,
    `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, moving_s,
       distance_m, avg_speed, avg_hr, start_lat, start_lon, end_lat, end_lon, hidden, derived_version)
     VALUES (1, ?, 'HKWorkoutActivityTypeCycling', 'ride', ?, ?, 60, ?, ?, 40000, ?, 140, 48.2, 16.4, 48.21, 16.41, ?, ?)`,
    [`r${ext++}`, start, start + movingS + 300, movingS + 300, movingS, 40000 / movingS, o.hidden ? 1 : 0, DERIVE_VERSION],
  );
  if (routeId !== null)
    run(db, 'INSERT INTO maps_workout_geo (workout_id, athlete_id, length_m, sig, route_id) VALUES (?, 1, 40000, ?, ?)', [
      id,
      new Uint8Array(16),
      routeId,
    ]);
  return id;
}

describe('similar activities: same route', () => {
  it('uses the route of Maps → Routes and ranks on it like the route card', () => {
    const old = routeRide(0, 7, 6000);
    routeRide(1, 7, 4000, { hidden: true });
    const other = routeRide(2, 8, 5300); // same start, finish and distance, but another course
    const r3 = routeRide(3, 7, 5600);
    const r2 = routeRide(4, 7, 5000);
    const cur = routeRide(5, 7, 5400);
    const s = similarActivities(db, 1, cur, 3)!;
    expect(s.items.map((x) => x.id)).toEqual([other, r3, r2, cur]);
    expect(s.items.filter((x) => x.sameRoute).map((x) => x.id)).toEqual([r3, r2, cur]);
    // by time among every visible activity on the route, also those beyond `limit` (old)
    expect({ rank: s.routeRank, count: s.routeCount }).toEqual({ rank: 2, count: 4 });
    expect(old).toBeGreaterThan(0);
    // alone on its route: no rank
    const single = similarActivities(db, 1, other)!;
    expect({ rank: single.routeRank, count: single.routeCount }).toEqual({ rank: null, count: 1 });
    expect(single.items.filter((x) => x.sameRoute).map((x) => x.id)).toEqual([other]);
  });

  it('falls back to start, finish and distance without a route', () => {
    routeRide(0, null, 5000);
    routeRide(1, null, 5600);
    const cur = routeRide(2, null, 5400);
    routeRide(3, 9, 5200); // on a route of its own
    const s = similarActivities(db, 1, cur)!;
    expect(s.items.every((x) => x.sameRoute)).toBe(true);
    // by average speed among them (5000 s, 5200 s, 5400 s, 5600 s)
    expect({ rank: s.routeRank, count: s.routeCount }).toEqual({ rank: 3, count: 4 });
  });
});
