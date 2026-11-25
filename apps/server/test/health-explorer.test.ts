import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExplorerResponse } from '@cadence/shared';
import { run } from '../src/db/db';
import { createHealthFixture, ts, type HealthFixture } from './health-fixture';

/** The explorer's items follow the rule of every analysis: hidden workouts and duplicate copies do not count. */
let fx: HealthFixture;

function workout(id: number, o: { hidden?: number; duplicateOf?: number | null; hasRoute?: number; routeFiles?: number }) {
  const start = ts(`2026-03-0${id}T08:00:00+01:00`);
  run(
    fx.db,
    `INSERT INTO workouts (id, athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, hidden, duplicate_of, has_route)
     VALUES (?, 1, ?, 'HKWorkoutActivityTypeRunning', 'run', ?, ?, 60, 3600, ?, ?, ?)`,
    [id, `w${id}`, start, start + 3600, o.hidden ?? 0, o.duplicateOf ?? null, o.hasRoute ?? 1],
  );
  for (let f = 0; f < (o.routeFiles ?? 1); f++)
    run(fx.db, 'INSERT INTO workout_routes (workout_id, file, point_count) VALUES (?, ?, 100)', [id, `route_${id}_${f}.gpx`]);
}

beforeAll(async () => {
  fx = await createHealthFixture();
  workout(1, {}); // visible run with a route
  workout(2, { routeFiles: 2 }); // visible, its track was split over two route files
  workout(3, { hidden: 1 }); // hidden by the athlete
  workout(4, { duplicateOf: 1 }); // the Apple Health copy of workout 1 (the FIT file wins)
  workout(5, { hasRoute: 0, routeFiles: 0 }); // treadmill run: no route
}, 60_000);

afterAll(async () => {
  await fx?.close();
});

describe('health explorer: workouts and routes', () => {
  it('counts the visible workouts and those of them with a route', async () => {
    const ex = await fx.getJson<ExplorerResponse>('/api/health/explorer');
    const count = (key: string) => ex.items.find((i) => i.key === key)?.count;
    expect(count('workouts')).toBe(3);
    expect(count('routes')).toBe(2);
  });
});
