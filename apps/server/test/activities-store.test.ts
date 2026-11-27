import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { all, get, openDb, run, type Db } from '../src/db/db';
import { DERIVE_VERSION } from '../src/derive/context';
import { ANALYSIS_VERSION, deriveAnalyses, staleAnalyses } from '../src/features/activities/store';
import type { DeriveContext } from '../src/features/types';
import { gzipJson } from '../src/lib/gzip';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-analysis-'));
  db = openDb(path.join(dir, 'data', 'cadence.db'));
  migrateAll(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let ext = 0;
function workout(): number {
  const start = 1_750_000_000 + ext * 86400;
  return run(
    db,
    `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, derived_version)
     VALUES (1, ?, 'HKWorkoutActivityTypeRunning', 'run', ?, ?, 120, 3600, ?)`,
    [`w${ext++}`, start, start + 3600, DERIVE_VERSION],
  ).lastInsertRowid;
}

/** Derive context; `computed` collects how many analyses each run computed (from the progress message). */
function ctx(workoutIds: number[] | 'all', computed: number[]): DeriveContext {
  return {
    db,
    athleteId: 1,
    workoutIds,
    sinceDay: null,
    report: (f, message) => {
      if (f === 1) computed.push(message ? Number(message.split(' / ')[1]) : 0);
    },
    checkCancelled: () => {},
    log: () => {},
  };
}

const keyOf = (id: number) => get<{ k: string }>(db, 'SELECT cache_key AS k FROM activities_analysis WHERE workout_id = ?', [id])?.k;

describe('activity analysis cache', () => {
  it('catches up missing and outdated rows and recomputes nothing else', () => {
    const ids = [workout(), workout(), workout()];
    const n: number[] = [];
    // an import of one new workout also fills the rows a cancelled run left out
    deriveAnalyses(ctx([ids[0]!], n));
    expect(n).toEqual([3]);
    expect(staleAnalyses(db, 1)).toEqual([]);
    // a full rebuild (e.g. after the resting HR moved) has nothing to do
    deriveAnalyses(ctx('all', n));
    expect(n.at(-1)).toBe(0);
    // an analysis of an older algorithm version is recomputed by the next run, whatever its scope
    run(db, "UPDATE activities_analysis SET cache_key = '1' || substr(cache_key, 2) WHERE workout_id = ?", [ids[1]]);
    expect(staleAnalyses(db, 1)).toEqual([ids[1]]);
    deriveAnalyses(ctx([], n));
    expect(n.at(-1)).toBe(1);
    expect(keyOf(ids[1]!)!.startsWith(`${ANALYSIS_VERSION}|`)).toBe(true);
    // a rename only touches updated_at: not stale for the catch-up at start, but the next run refreshes it
    run(db, 'UPDATE workouts SET updated_at = updated_at + 10 WHERE id = ?', [ids[2]]);
    expect(staleAnalyses(db, 1)).toEqual([]);
    deriveAnalyses(ctx('all', n));
    expect(n.at(-1)).toBe(1);
  });

  it('one workout the analysis fails on does not hold up the others', () => {
    // the oldest workout's stream decodes but is no stream: its analysis throws, in every run (it stays stale)
    const [bad, a, b] = [workout(), workout(), workout()];
    run(db, 'INSERT INTO workout_streams (workout_id, version, points, data) VALUES (?, 1, 2, ?)', [bad, gzipJson({})]);
    const n: number[] = [];
    // an import of the newest workout
    expect(() => deriveAnalyses(ctx([b!], n))).toThrow(new RegExp(`^1 of 3 analyses failed \\(workout ${bad}: `));
    expect(n).toEqual([3]);
    expect([a, b].map((id) => keyOf(id!)?.startsWith(`${ANALYSIS_VERSION}|`))).toEqual([true, true]);
    expect(staleAnalyses(db, 1)).toEqual([bad]);
    // the next run only retries that one
    expect(() => deriveAnalyses(ctx([], n))).toThrow(/^1 of 1 analyses failed/);
  });

  it('refreshes stale analyses in the background when the server starts', async () => {
    const ids = [workout(), workout()];
    deriveAnalyses(ctx('all', []));
    run(db, "UPDATE activities_analysis SET cache_key = '1' || substr(cache_key, 2) WHERE workout_id = ?", [ids[0]]);
    run(db, 'DELETE FROM activities_analysis WHERE workout_id = ?', [ids[1]]);
    const config = loadConfig({ CADENCE_DATA_DIR: path.join(dir, 'data'), CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
    const app = await buildApp(config, db, { jobRunner: 'inline' });
    try {
      await app.ready();
      for (let i = 0; i < 400 && app.jobs.busy(1); i++) await new Promise((r) => setTimeout(r, 10));
      const jobs = all<{ status: string; options: string }>(db, "SELECT status, options FROM import_jobs WHERE kind = 'rederive'");
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.status).toBe('done');
      expect(JSON.parse(jobs[0]!.options)).toMatchObject({ origin: 'upgrade', workoutIds: [] });
      expect(staleAnalyses(db, 1)).toEqual([]);
      for (const id of ids) expect(keyOf(id)!.startsWith(`${ANALYSIS_VERSION}|`)).toBe(true);
    } finally {
      await app.close();
    }
    // nothing stale: no job at the next start
    const again = await buildApp(config, db, { jobRunner: 'inline' });
    await again.ready();
    expect(again.jobs.busy(1)).toBe(false);
    await again.close();
  });
});
