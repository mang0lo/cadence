import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { all, openDb, run, type Db } from '../src/db/db';
import { DERIVE_VERSION } from '../src/derive/context';
import { compareEfforts } from '../src/features/activities/best-efforts';
import { activitySummary, medalsFor } from '../src/features/activities/queries';
import { records } from '../src/features/progress/records';
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
  efforts: Record<string, number>,
  o: { hour?: number; tzMin?: number; hidden?: boolean; duplicateOf?: number; sport?: string } = {},
): number {
  const tzMin = o.tzMin ?? 60;
  const start = parseDay(day)! * 86400 + (o.hour ?? 8) * 3600 - tzMin * 60;
  const sport = o.sport ?? 'run';
  const { lastInsertRowid: id } = run(
    db,
    `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, hidden,
       duplicate_of, derived_version)
     VALUES (1, ?, 'HKWorkoutActivityTypeRunning', ?, ?, ?, ?, 3600, ?, ?, ?)`,
    [`k${ext++}`, sport, start, start + 3600, tzMin, o.hidden ? 1 : 0, o.duplicateOf ?? null, DERIVE_VERSION],
  );
  const dist: Record<string, number> = { '1k': 1000, '5k': 5000, '10k': 10000, '20k': 20000 };
  for (const [effort, elapsed] of Object.entries(efforts))
    run(
      db,
      `INSERT INTO best_efforts (athlete_id, workout_id, sport, effort, distance_m, elapsed_s, start_offset_s, start_ts)
       VALUES (1, ?, ?, ?, ?, ?, 0, ?)`,
      [id, sport, effort, dist[effort] ?? 1000, elapsed, start],
    );
  return id;
}

const medalOf = (m: Map<number, { effort: string; rank: number }[]>, id: number, effort: string) =>
  m.get(id)?.find((x) => x.effort === effort)?.rank ?? null;

describe('best effort ranking', () => {
  it('a tie goes to the earlier attempt, whatever the import order', () => {
    // imported first, run later
    const later = runOn('2026-03-10', { '5k': 1500 });
    // imported later (e.g. from a FIT file), run earlier
    const earlier = runOn('2026-03-05', { '5k': 1500 });
    const slower = runOn('2026-03-01', { '5k': 1510 });
    const m = medalsFor(db, 1, [later, earlier, slower]);
    expect([earlier, later, slower].map((id) => medalOf(m, id, '5k'))).toEqual([1, 2, 3]);
    // the record of Progress → Records is the same attempt
    const r = records(db, 1, { sport: 'run', today: '2026-03-31' });
    expect(r.efforts.find((e) => e.effort === '5k')!.allTime!.workoutId).toBe(earlier);
    // one PR per effort
    expect(activitySummary(db, 1, '2026-03-31', 1).recentPrs).toBe(1);
  });

  it('counts the PRs of the last 30 local days', () => {
    // today 2026-03-31: the window starts at local midnight of 2026-03-02
    runOn('2026-03-01', { '1k': 200 }, { hour: 18, tzMin: 120 }); // 30 days ago in the evening: not counted
    runOn('2026-03-02', { '5k': 1500 }, { hour: 0.5, tzMin: 120 }); // just after local midnight (22:30 UTC the day before)
    runOn('2026-03-02', { '10k': 3100 }, { hour: 1, tzMin: -600 });
    runOn('2026-03-20', { '20k': 7000 }, { hidden: true }); // hidden: no PR
    runOn('2026-03-25', { '20k': 7100 });
    expect(activitySummary(db, 1, '2026-03-31', 1).recentPrs).toBe(3);
    expect(activitySummary(db, 1, '2026-04-01', 1).recentPrs).toBe(1);
  });

  it('a PR beaten since is no recent PR', () => {
    runOn('2026-03-20', { '5k': 1500, '10k': 3100 });
    runOn('2025-01-01', { '5k': 1490 }); // older and faster: the 5k record is old
    runOn('2026-03-25', { '10k': 3100 }); // the same 10k time later: the record stays with 2026-03-20
    expect(activitySummary(db, 1, '2026-03-31', 1).recentPrs).toBe(1);
  });

  it('medals equal a full ranking of the visible efforts', () => {
    const ids: number[] = [];
    for (let i = 0; i < 40; i++) {
      const efforts: Record<string, number> = { '5k': 1400 + ((i * 37) % 23) * 5 };
      if (i % 3 === 0) efforts['10k'] = 3000 + ((i * 11) % 7) * 10;
      ids.push(
        runOn(`2026-0${1 + (i % 9)}-${String(1 + ((i * 7) % 28)).padStart(2, '0')}`, efforts, {
          hidden: i % 10 === 4,
          duplicateOf: i % 10 === 7 ? ids[0] : undefined,
          sport: i % 8 === 5 ? 'walk' : 'run',
        }),
      );
    }
    const rows = all<{ workout_id: number; sport: string; effort: string; elapsed_s: number; start_ts: number }>(
      db,
      `SELECT be.workout_id, be.sport, be.effort, be.elapsed_s, be.start_ts FROM best_efforts be
       JOIN workouts w ON w.id = be.workout_id WHERE w.hidden = 0 AND w.duplicate_of IS NULL`,
    );
    const expected = new Map<string, number>();
    for (const key of new Set(rows.map((r) => `${r.sport}|${r.effort}`))) {
      rows
        .filter((r) => `${r.sport}|${r.effort}` === key)
        .sort(compareEfforts)
        .slice(0, 3)
        .forEach((r, i) => expected.set(`${r.workout_id}|${r.effort}`, i + 1));
    }
    const got = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 7)
      for (const [id, medals] of medalsFor(db, 1, ids.slice(i, i + 7)))
        for (const m of medals) got.set(`${id}|${m.effort}`, m.rank);
    expect(got).toEqual(expected);
    expect(got.size).toBeGreaterThan(6);
  });
});
