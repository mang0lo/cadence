import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TrophiesResponse } from '@cadence/shared';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { getSetting, setSetting } from '../src/core/settings';
import { all, openDb, run, type Db } from '../src/db/db';
import { DERIVE_VERSION } from '../src/derive/context';
import { refreshDailyActivity } from '../src/derive/daily';
import { achievementsStep } from '../src/features/consistency/trophies';
import { consistencyWhatsNew } from '../src/features/consistency/whats-new';
import type { DeriveContext } from '../src/features/types';
import { resetAthleteData } from '../src/import/reset';
import { addDays, nowSec } from '../src/lib/time';

/** Which trophies count as new: never on a first import (also after "Delete all data"), only for later imports. */
let dir: string;
let db: Db;
let app: FastifyInstance;
const TODAY = '2026-06-20';

let ext = 0;
function addRun(day: string, distanceM = 6_000): number {
  const start = Date.parse(`${day}T07:00:00+02:00`) / 1000;
  return Number(
    run(
      db,
      `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, distance_m, derived_version)
       VALUES (1, ?, 'HKWorkoutActivityTypeRunning', 'run', ?, ?, 120, 1800, ?, ?)`,
      [`k${ext++}`, start, start + 1800, distanceM, DERIVE_VERSION],
    ).lastInsertRowid,
  );
}

/** The workouts of an import arrive (daily_activity is written by the core derive steps), then the trophy step runs. */
async function deriveAfterImport(ids: number[]) {
  refreshDailyActivity(db, 1);
  const ctx: DeriveContext = {
    db,
    athleteId: 1,
    workoutIds: ids,
    sinceDay: null,
    report: () => {},
    checkCancelled: () => {},
    log: () => {},
  };
  await achievementsStep.run(ctx);
}

const trophies = async () => {
  const res = await app.inject({ url: `/api/consistency/trophies?today=${TODAY}` });
  expect(res.statusCode).toBe(200);
  return res.json<TrophiesResponse>();
};
const earnedNew = (t: TrophiesResponse) => t.achievements.filter((a) => a.isNew).map((a) => a.key);
const whatsNew = (since: number, initial: boolean, workoutIds: number[]) =>
  consistencyWhatsNew({ db, athleteId: 1, since, initial, workoutIds }).map((h) => (h.data as { key: string }).key);

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-trophies-'));
  const config = loadConfig({ CADENCE_DATA_DIR: path.join(dir, 'data'), CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
  db = openDb(config.dbPath);
  migrateAll(db);
  app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Ten daily runs ending on 19 June, inserted in two parts with the trophies page opened in between. */
async function firstImport(): Promise<{ ids: number[]; partial: TrophiesResponse }> {
  const ids: number[] = [];
  for (let i = 0; i < 3; i++) ids.push(addRun(addDays('2026-06-10', i)));
  refreshDailyActivity(db, 1);
  // the trophies page is opened while the import is still running
  const partial = await trophies();
  for (let i = 3; i < 10; i++) ids.push(addRun(addDays('2026-06-10', i)));
  await deriveAfterImport(ids);
  return { ids, partial };
}

describe('trophies: what counts as new', () => {
  it('flags nothing on the first import, also when the page cached part of it', async () => {
    const since = nowSec() - 1;
    const { ids, partial } = await firstImport();
    // without a cache the page computed the trophies of the first three runs
    expect(partial.achievements.find((a) => a.key === 'activities.1')).toMatchObject({ earned: true });
    const t = await trophies();
    expect(t.achievements.find((a) => a.key === 'activities.10')).toMatchObject({ earned: true, isNew: false });
    expect(earnedNew(t)).toEqual([]);
    expect(whatsNew(since, true, ids)).toEqual([]);
  });

  it('shows the whole catalog after "Delete all data" and flags nothing when the same data comes back', async () => {
    resetAthleteData(db, 1);
    expect(getSetting(db, 1, 'consistency.achievementsMeta', null)).toBeNull();
    const empty = await trophies();
    expect(empty.achievements.length).toBeGreaterThan(0);
    expect(empty.summary.earned).toBe(0);

    const since = nowSec() - 1;
    const { ids } = await firstImport();
    const t = await trophies();
    expect(t.achievements.find((a) => a.key === 'activities.10')).toMatchObject({ earned: true, isNew: false });
    expect(earnedNew(t)).toEqual([]);
    expect(whatsNew(since, true, ids)).toEqual([]);
  });

  it('flags the trophies a later import earned', async () => {
    const since = nowSec() - 1;
    const half = addRun('2026-06-20', 21_100);
    await deriveAfterImport([half]);
    const t = await trophies();
    expect(t.achievements.find((a) => a.key === 'longest.run.21097.5')).toMatchObject({ earned: true, isNew: true });
    expect(whatsNew(since, false, [half])).toContain('longest.run.21097.5');
  });

  it('does not treat trophies that only appear through new rules as news', async () => {
    const before = earnedNew(await trophies());
    setSetting(db, 1, 'consistency.achievementsMeta', { version: 1, computedAt: 0, weekStart: 1 });
    run(db, "UPDATE consistency_achievements SET earned_day = NULL, first_seen_at = NULL WHERE key = 'activities.10'");
    const t = await trophies();
    expect(t.achievements.find((a) => a.key === 'activities.10')).toMatchObject({ earned: true, isNew: false });
    expect(earnedNew(t)).toEqual(before);
    expect(all(db, 'SELECT 1 FROM consistency_achievements WHERE athlete_id = 1').length).toBe(t.achievements.length);
  });
});

describe('trophies: a changed week start', () => {
  // runs on Sunday 10 May and the Mondays 18 May, 25 May and 1 June 2026: four weeks in a row in Sunday weeks, three
  // in Monday weeks
  let dir2: string;
  let db2: Db;
  let app2: FastifyInstance;
  const run2 = (day: string, distanceM: number): number => {
    const start = Date.parse(`${day}T07:00:00+02:00`) / 1000;
    return Number(
      run(
        db2,
        `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, distance_m, derived_version)
         VALUES (1, ?, 'HKWorkoutActivityTypeRunning', 'run', ?, ?, 120, 1800, ?, ?)`,
        [`w${day}`, start, start + 1800, distanceM, DERIVE_VERSION],
      ).lastInsertRowid,
    );
  };
  const derive2 = async (ids: number[]) => {
    refreshDailyActivity(db2, 1);
    await achievementsStep.run({ db: db2, athleteId: 1, workoutIds: ids, sinceDay: null, report: () => {}, checkCancelled: () => {}, log: () => {} });
  };
  const streak4 = async () => {
    const res = await app2.inject({ url: '/api/consistency/trophies?today=2026-06-20' });
    expect(res.statusCode).toBe(200);
    return res.json<TrophiesResponse>().achievements.find((a) => a.key === 'weekly_streak.4')!;
  };

  beforeAll(async () => {
    dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-trophies-week-'));
    const config = loadConfig({ CADENCE_DATA_DIR: path.join(dir2, 'data'), CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
    db2 = openDb(config.dbPath);
    migrateAll(db2);
    app2 = await buildApp(config, db2, { jobRunner: 'inline' });
    await app2.ready();
  });

  afterAll(async () => {
    await app2?.close();
    db2?.close();
    fs.rmSync(dir2, { recursive: true, force: true });
  });

  it('is not news, also when an import runs before the trophies are opened again', async () => {
    await derive2(['2026-05-10', '2026-05-18', '2026-05-25', '2026-06-01'].map((d) => run2(d, 6_000)));
    expect(await streak4()).toMatchObject({ earned: false });
    expect((await app2.inject({ method: 'PATCH', url: '/api/settings', payload: { weekStart: 0 } })).statusCode).toBe(200);
    // the next import (a short run in a week that changes no streak) comes before anyone opens the trophies
    const since = nowSec() - 1;
    const later = run2('2026-06-17', 1_000);
    await derive2([later]);
    expect(await streak4()).toMatchObject({ earned: true, isNew: false });
    expect(consistencyWhatsNew({ db: db2, athleteId: 1, since, initial: false, workoutIds: [later] })).toEqual([]);
  });
});
