import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { openDb, run, type Db } from '../src/db/db';
import { DERIVE_VERSION } from '../src/derive/context';
import { refreshDailyActivity } from '../src/derive/daily';
import { achievementsStep, readAchievements, resetAchievements } from '../src/features/consistency/trophies';
import type { DeriveContext } from '../src/features/types';
import { addDays, nowSec } from '../src/lib/time';

/**
 * A first import flags no trophy as new. An import that names every existing workout because it linked their routes
 * is no first import: what its new workouts earn is news.
 */
let db: Db;
const NOW = nowSec();
const DAY = 86_400;

beforeAll(() => {
  db = openDb(':memory:');
  migrateAll(db);
});

afterAll(() => db?.close());

beforeEach(() => {
  run(db, 'DELETE FROM workouts');
  run(db, 'DELETE FROM import_jobs');
  run(db, 'DELETE FROM consistency_achievements');
  resetAchievements(db, 1);
});

let ext = 0;
/** Runs on `n` days in a row from `firstDay`, stored at `createdAt`. */
function addRuns(firstDay: string, n: number, createdAt: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = Date.parse(`${addDays(firstDay, i)}T07:00:00+02:00`) / 1000;
    ids.push(
      run(
        db,
        `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, distance_m,
           derived_version, created_at)
         VALUES (1, ?, 'HKWorkoutActivityTypeRunning', 'run', ?, ?, 120, 1800, 6000, ?, ?)`,
        [`k${ext++}`, start, start + 1800, DERIVE_VERSION, createdAt],
      ).lastInsertRowid,
    );
  }
  return ids;
}

const runningImport = (startedAt: number) =>
  run(db, "INSERT INTO import_jobs (id, athlete_id, kind, status, started_at) VALUES (?, 1, 'import', 'running', ?)", [
    `job-${startedAt}`,
    startedAt,
  ]);

async function derive(workoutIds: number[]) {
  refreshDailyActivity(db, 1);
  const ctx: DeriveContext = { db, athleteId: 1, workoutIds, sinceDay: null, report: () => {}, checkCancelled: () => {}, log: () => {} };
  await achievementsStep.run(ctx);
}

const isNew = (key: string) => readAchievements(db, 1).find((a) => a.key === key)?.isNew;
const earned = (key: string) => readAchievements(db, 1).find((a) => a.key === key)?.earned;

describe('trophies of an import that also names existing workouts', () => {
  it('flags what the new workouts earn when the import linked the routes of every older workout', async () => {
    const old = addRuns('2026-05-01', 9, NOW - 30 * DAY);
    await derive(old); // the first import
    expect(earned('activities.10')).toBe(false);
    // the next import: one new run, and the routes of the nine older runs linked on the way
    runningImport(NOW - 60);
    const added = addRuns('2026-05-20', 1, NOW - 30);
    await derive([...old, ...added]);
    expect(earned('activities.10')).toBe(true);
    expect(isNew('activities.10')).toBe(true);
  });

  it('flags nothing on a real first import, also when the trophies were opened while it ran', async () => {
    runningImport(NOW - 60);
    const first = addRuns('2026-05-01', 5, NOW - 50);
    await derive(first); // a trophies page opened half way through
    const rest = addRuns('2026-05-06', 5, NOW - 40);
    await derive([...first, ...rest]);
    expect(earned('activities.10')).toBe(true);
    expect(isNew('activities.10')).toBe(false);
  });

  it('keeps the old rule without a running import job (the command line import)', async () => {
    const first = addRuns('2026-05-01', 5, NOW - 50);
    await derive(first);
    const rest = addRuns('2026-05-06', 5, NOW - 40);
    await derive([...first, ...rest]);
    expect(isNew('activities.10')).toBe(false);
  });
});
