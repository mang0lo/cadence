import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { get, openDb, run, type Db } from '../src/db/db';
import { DERIVE_VERSION } from '../src/derive/context';
import type { ImportPhase } from '@cadence/shared';
import { JobManager, mergeDeriveOptions } from '../src/import/jobs';
import { progressSaver, type JobOptions } from '../src/import/run-job';
import { startImportWatcher } from '../src/import/watch';
import { emptyStats } from '../src/import/writer';

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

  it('keeps the progress of a worker job in memory: the HTTP thread does not wait for the database', async () => {
    run(db, "INSERT INTO import_jobs (id, athlete_id, kind, status, progress) VALUES ('w', 1, 'import', 'running', 0)");
    const jobs = new JobManager(
      db,
      { dbPath: path.join(dir, 'cadence.db'), uploadsDir: path.join(dir, 'uploads') },
      'worker',
    );
    // the state pump() sets up for a job, without starting a worker thread
    const inner = jobs as unknown as { running: unknown; onProgress(r: unknown, m: unknown): void };
    const r = {
      id: 'w',
      athleteId: 1,
      job: jobs.get(1, 'w')!,
      options: {},
      sourcePath: null,
      startedMs: Date.now(),
      cancel: new Int32Array(new SharedArrayBuffer(4)),
      worker: null,
      done: false,
    };
    inner.running = r;
    // the worker is inside a write transaction (a record flush)
    const worker = openDb(path.join(dir, 'cadence.db'));
    db.exec('PRAGMA busy_timeout = 50');
    worker.exec('BEGIN IMMEDIATE');
    try {
      inner.onProgress(r, { phase: 'parse', progress: 0.4, message: 'Parsing', step: null, stats: emptyStats() });
      expect(jobs.get(1, 'w')).toMatchObject({ status: 'running', phase: 'parse', progress: 0.4, message: 'Parsing' });
    } finally {
      worker.exec('ROLLBACK');
      worker.close();
    }
    inner.running = null;
  });

  it("saves a job's progress on its own connection, on phase changes and now and then", () => {
    run(db, "INSERT INTO import_jobs (id, athlete_id, kind, status, progress) VALUES ('p', 1, 'import', 'running', 0)");
    const row = () =>
      get<{ phase: string | null; progress: number; message: string | null }>(
        db,
        "SELECT phase, progress, message FROM import_jobs WHERE id = 'p'",
      )!;
    const save = progressSaver(db, 'p', 60_000);
    const p = (phase: ImportPhase, progress: number, message: string) => ({
      phase,
      progress,
      message,
      step: null,
      stats: emptyStats(),
    });
    save(p('parse', 0.1, 'Parsing'));
    expect(row()).toEqual({ phase: 'parse', progress: 0.1, message: 'Parsing' });
    // the same phase again within the interval is not written; a new phase is, and progress never goes back
    save(p('parse', 0.3, 'Parsing on'));
    expect(row().progress).toBe(0.1);
    save(p('routes', 0.2, 'Routes'));
    expect(row()).toEqual({ phase: 'routes', progress: 0.3, message: 'Routes' });
    // a database another connection keeps locked: the save is skipped instead of failing the job
    const other = openDb(path.join(dir, 'cadence.db'));
    db.exec('PRAGMA busy_timeout = 50');
    other.exec('BEGIN IMMEDIATE');
    try {
      expect(() => save(p('ecg', 0.5, 'ECGs'))).not.toThrow();
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
    expect(row().phase).toBe('routes');
    // the final status of a job that stopped is never overwritten
    run(db, "UPDATE import_jobs SET status = 'cancelled', message = 'Cancelled' WHERE id = 'p'");
    save(p('derive', 0.8, 'Deriving'));
    expect(row()).toEqual({ phase: 'routes', progress: 0.3, message: 'Cancelled' });
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

  it('imports a file again when its import was interrupted, but not when the file was the problem', async () => {
    const watchDir = path.join(dir, 'inbox');
    fs.mkdirSync(watchDir);
    const jobs = new Map<string, { status: string; error: string | null; file: string }>();
    const fake = {
      enqueueImport: (_a: number, file: string) => {
        const id = `j${jobs.size + 1}`;
        jobs.set(id, { status: 'queued', error: null, file: path.basename(file) });
        return { id };
      },
      get: (_a: number, id: string) => jobs.get(id) ?? null,
    } as unknown as JobManager;
    fs.writeFileSync(path.join(watchDir, 'export.zip'), 'PK fake');
    fs.writeFileSync(path.join(watchDir, 'broken.zip'), 'PK broken');
    const stop = startImportWatcher(db, fake, watchDir, 1, 40);
    const settle = () => new Promise((r) => setTimeout(r, 200));
    await settle();
    expect([...jobs.values()].map((j) => j.file).sort()).toEqual(['broken.zip', 'export.zip']);
    const job = (file: string) => [...jobs.entries()].filter(([, j]) => j.file === file).at(-1)!;
    // the server stopped during both imports (still queued: nothing happens)
    await settle();
    expect(jobs.size).toBe(2);
    job('export.zip')[1].status = 'failed';
    job('export.zip')[1].error = 'Interrupted: the server stopped while this job was running';
    job('broken.zip')[1].status = 'failed';
    job('broken.zip')[1].error = 'Not a readable zip file: invalid central directory';
    await settle();
    // the interrupted one is queued again, the broken file is not
    expect([...jobs.values()].map((j) => j.file).sort()).toEqual(['broken.zip', 'export.zip', 'export.zip']);
    // a worker crash twice more: three attempts in all
    for (const error of ['Import worker crashed: out of memory', 'Import worker exited unexpectedly (code 134)']) {
      job('export.zip')[1].status = 'failed';
      job('export.zip')[1].error = error;
      await settle();
    }
    expect([...jobs.values()].filter((j) => j.file === 'export.zip')).toHaveLength(3);
    stop();
    const seen = JSON.parse(get<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'core.importWatch'")!.value);
    expect(typeof seen['export.zip']).toBe('string');
    expect(typeof seen['broken.zip']).toBe('string');
  });
});
