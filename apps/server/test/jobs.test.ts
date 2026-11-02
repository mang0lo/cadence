import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { get, openDb, run, type Db } from '../src/db/db';
import { JobManager } from '../src/import/jobs';
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
