import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { get, openDb, run, type Db } from '../src/db/db';
import { DERIVE_VERSION } from '../src/derive/context';
import { JobManager, mergeDeriveOptions } from '../src/import/jobs';
import type { JobOptions } from '../src/import/run-job';
import { startImportWatcher } from '../src/import/watch';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-jobs-'));
  db = openDb(path.join(dir, 'cadence.db'));
  migrateAll(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('job manager', () => {
  it('rebuilds the analysis once after an update of the derivation', async () => {
    const insert = (key: string, version: number) =>
      run(
        db,
        `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, derived_version)
         VALUES (1, ?, 'HKWorkoutActivityTypeRunning', 'run', 1750000000, 1750003600, 120, 3600, ?)`,
        [key, version],
      );
    insert('current', DERIVE_VERSION);
    const cfg = { dbPath: path.join(dir, 'cadence.db'), uploadsDir: path.join(dir, 'uploads') };
    // everything up to date: no job
    let jobs = new JobManager(db, cfg, 'inline');
    jobs.start();
    expect(jobs.busy(1)).toBe(false);
    await jobs.close();
    // a workout analysed by an older version: one background rebuild of the analysis
    insert('old', DERIVE_VERSION - 1);
    jobs = new JobManager(db, cfg, 'inline');
    jobs.start();
    const rows = db.prepare("SELECT kind, options FROM import_jobs WHERE kind = 'rederive'").all() as {
      kind: string;
      options: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.options)).toMatchObject({ origin: 'upgrade', workoutIds: 'all' });
    await jobs.close();
  });

  it('marks jobs that were running when the server stopped as failed', async () => {
    run(
      db,
      "INSERT INTO import_jobs (id, athlete_id, kind, status, progress) VALUES ('stale', 1, 'import', 'running', 0.4)",
    );
    run(
      db,
      "INSERT INTO import_jobs (id, athlete_id, kind, status, progress, source_path) VALUES ('gone', 1, 'import', 'queued', 0, '/nope.zip')",
    );
    const jobs = new JobManager(
      db,
      { dbPath: path.join(dir, 'cadence.db'), uploadsDir: path.join(dir, 'uploads') },
      'inline',
    );
    jobs.start();
    expect(jobs.get(1, 'stale')).toMatchObject({ status: 'failed', error: expect.stringMatching(/stopped/) });
    expect(jobs.get(1, 'gone')).toMatchObject({ status: 'failed', error: 'Source file is gone' });
    expect(jobs.busy(1)).toBe(false);
    await jobs.close();
  });

  it('runs derive requests that pile up in the queue as one job', async () => {
    const jobs = new JobManager(
      db,
      { dbPath: path.join(dir, 'cadence.db'), uploadsDir: path.join(dir, 'uploads') },
      'inline',
    );
    // not started: the jobs stay queued
    const a = jobs.enqueueDerive(1, { origin: 'workout', workoutIds: [7], sinceDay: '2026-05-02', records: false });
    const b = jobs.enqueueDerive(1, { origin: 'workout', workoutIds: [3], sinceDay: '2026-04-20', records: false });
    expect(b.id).toBe(a.id);
    const options = () =>
      (db.prepare("SELECT options FROM import_jobs WHERE kind = 'rederive'").all() as { options: string }[]).map((r) =>
        JSON.parse(r.options),
      );
    expect(options()).toEqual([{ origin: 'workout', workoutIds: [3, 7], sinceDay: '2026-04-20', records: false }]);
    // a settings change (every record type from today) widens it, a full rebuild absorbs everything
    jobs.enqueueDerive(1, { origin: 'settings', workoutIds: [], sinceDay: '2026-05-10' });
    expect(options()).toEqual([{ origin: 'workout', workoutIds: [3, 7], sinceDay: '2026-04-20' }]);
    expect(jobs.enqueueDerive(1, { origin: 'settings' }).id).toBe(a.id);
    expect(options()).toEqual([{ origin: 'workout', workoutIds: 'all', sinceDay: null }]);
    // another athlete, or an import in between, gets its own job
    run(db, 'INSERT INTO athletes (id) VALUES (2)');
    expect(jobs.enqueueDerive(2).id).not.toBe(a.id);
    expect(jobs.list(1)).toHaveLength(1);
    await jobs.close();
  });

  it('merges derive requests without losing any of their scope', () => {
    const merge = (a: JobOptions, b: JobOptions) => mergeDeriveOptions(a, b);
    // a request with records but no day means every day
    expect(merge({ workoutIds: [1], sinceDay: '2026-05-01', records: false }, { workoutIds: [2], sinceDay: null })).toEqual({
      workoutIds: [1, 2],
      sinceDay: null,
    });
    // one without records and without a day only names its workouts
    expect(merge({ workoutIds: [1], sinceDay: null, records: false }, { workoutIds: [2], sinceDay: '2026-05-01' })).toEqual({
      workoutIds: [1, 2],
      sinceDay: '2026-05-01',
    });
    expect(
      merge({ workoutIds: [1], sinceDay: null, records: false }, { workoutIds: [2], sinceDay: '2026-05-01', records: false }),
    ).toEqual({ workoutIds: [1, 2], sinceDay: '2026-05-01', records: false });
    expect(merge({ workoutIds: [1], sinceDay: '2026-05-03' }, { workoutIds: 'all' })).toEqual({ workoutIds: 'all', sinceDay: null });
  });

  it('cancels queued jobs', async () => {
    const jobs = new JobManager(
      db,
      { dbPath: path.join(dir, 'cadence.db'), uploadsDir: path.join(dir, 'uploads') },
      'inline',
    );
    // not started: the job stays queued
    const job = jobs.enqueueDerive(1);
    expect(job.status).toBe('queued');
    expect(jobs.busy(1)).toBe(true);
    expect(jobs.cancel(1, job.id)?.status).toBe('cancelled');
    expect(jobs.list(1).map((j) => j.status)).toEqual(['cancelled']);
    await jobs.close();
  });
});

describe('import folder watcher', () => {
  it('imports new exports once they stopped changing, and only once', async () => {
    const watchDir = path.join(dir, 'inbox');
    fs.mkdirSync(watchDir);
    const queued: string[] = [];
    const fake = {
      enqueueImport: (_a: number, file: string) => queued.push(path.basename(file)),
    } as unknown as JobManager;
    fs.writeFileSync(path.join(watchDir, 'export.zip'), 'PK fake');
    fs.writeFileSync(path.join(watchDir, 'notes.txt'), 'ignored');
    const stop = startImportWatcher(db, fake, watchDir, 1, 40);
    await new Promise((r) => setTimeout(r, 200));
    expect(queued).toEqual(['export.zip']);
    // a second watcher (server restart) remembers what was imported
    stop();
    const stop2 = startImportWatcher(db, fake, watchDir, 1, 40);
    await new Promise((r) => setTimeout(r, 200));
    expect(queued).toEqual(['export.zip']);
    stop2();
    expect(
      get<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'core.importWatch'")!.value,
    ).toContain('export.zip');
  });
});
