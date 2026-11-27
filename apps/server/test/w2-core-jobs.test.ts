import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImportJob } from '@cadence/shared';
import { migrateAll } from '../src/app';
import { openDb, run, type Db } from '../src/db/db';
import { coreDeriveSteps } from '../src/derive/pipeline';
import { features } from '../src/features';
import { JobManager, jobErrorCode } from '../src/import/jobs';
import { executeJob, type JobProgress } from '../src/import/run-job';

let dir: string;
let db: Db;
let cfg: { dbPath: string; uploadsDir: string };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-w2-jobs-'));
  db = openDb(path.join(dir, 'cadence.db'));
  migrateAll(db);
  cfg = { dbPath: path.join(dir, 'cadence.db'), uploadsDir: path.join(dir, 'uploads') };
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const idle = async (jobs: JobManager) => {
  for (let i = 0; i < 500 && jobs.busy(1); i++) await new Promise((r) => setTimeout(r, 10));
};

describe('structured job progress', () => {
  it('names the running derive step by its id next to the English label', async () => {
    const steps = [...coreDeriveSteps, ...features.flatMap((f) => f.deriveSteps ?? [])];
    const labelOf = new Map(steps.map((s) => [s.id, s.label]));
    const seen: JobProgress[] = [];
    await executeJob(db, { id: 'x', kind: 'rederive', athleteId: 1, sourcePath: null, options: {} }, {
      progress: (p) => void seen.push({ ...p }),
      checkCancelled: () => {},
      log: () => {},
    });
    const derive = seen.filter((p) => p.step !== null);
    expect(derive.length).toBeGreaterThan(0);
    for (const p of derive) {
      expect(p.stepId, p.step!).toBeTruthy();
      expect(labelOf.get(p.stepId!)).toBe(p.step);
    }
    expect(derive[0]!.stepId).toBe(steps[0]!.id);
    // outside a derive step there is none
    for (const p of seen.filter((x) => x.step === null)) expect(p.stepId ?? null).toBeNull();
  });

  it('shows the step id of a running job', async () => {
    const jobs = new JobManager(db, cfg, 'inline');
    const updates: ImportJob[] = [];
    jobs.onUpdate((j) => void updates.push(j));
    jobs.start();
    const job = jobs.enqueueDerive(1);
    await idle(jobs);
    const derive = updates.filter((j) => j.status === 'running' && j.step);
    expect(derive[0]).toMatchObject({ stepId: 'core.workouts', step: 'Workout streams, splits & best efforts' });
    // a finished job has no step
    expect(jobs.get(1, job.id)).toMatchObject({ status: 'done', stepId: null, errorCode: null });
    await jobs.close();
  });
});

describe('error codes of failed jobs', () => {
  it('says that an import file cannot be read, keeping the English detail', async () => {
    const jobs = new JobManager(db, cfg, 'inline');
    jobs.start();
    const inputs: [string, string, RegExp][] = [
      ['broken.zip', 'PK\x03\x04 but no zip', /^Not a readable zip file/],
      ['export.xml', '<?xml version="1.0"?><ClinicalDocument/>', /^Not an Apple Health export\.xml/],
    ];
    for (const [name, content, error] of inputs) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, content);
      const job = jobs.enqueueImport(1, file);
      await idle(jobs);
      expect(jobs.get(1, job.id), name).toMatchObject({ status: 'failed', errorCode: 'invalid_input', error: expect.stringMatching(error) });
    }
    await jobs.close();
  });

  it('tells what stopped a job at the last restart', async () => {
    fs.mkdirSync(cfg.uploadsDir, { recursive: true });
    const elsewhere = path.join(dir, 'elsewhere.zip');
    fs.writeFileSync(elsewhere, 'PK');
    run(db, "INSERT INTO import_jobs (id, athlete_id, kind, status) VALUES ('running', 1, 'import', 'running')");
    run(db, "INSERT INTO import_jobs (id, athlete_id, kind, status, source_path) VALUES ('gone', 1, 'import', 'queued', ?)", [
      path.join(cfg.uploadsDir, 'gone.zip'),
    ]);
    run(db, "INSERT INTO import_jobs (id, athlete_id, kind, status, source_path) VALUES ('local', 1, 'import', 'queued', ?)", [
      elsewhere,
    ]);
    const jobs = new JobManager(db, { ...cfg, allowLocalImport: false }, 'inline');
    jobs.start();
    await jobs.close();
    expect(jobs.get(1, 'running')).toMatchObject({ status: 'failed', errorCode: 'interrupted' });
    expect(jobs.get(1, 'gone')).toMatchObject({ status: 'failed', errorCode: 'source_gone' });
    expect(jobs.get(1, 'local')).toMatchObject({ status: 'failed', errorCode: 'not_resumed' });
  });

  it('gives jobs failed before the codes existed a code from their text', () => {
    const insert = (id: string, status: string, error: string | null) =>
      run(db, 'INSERT INTO import_jobs (id, athlete_id, kind, status, error) VALUES (?, 1, ?, ?, ?)', [id, 'import', status, error]);
    insert('crashed', 'failed', 'Import worker crashed: out of memory');
    insert('exited', 'failed', 'Import worker exited unexpectedly (code 1)');
    insert('spawn', 'failed', 'Could not start the import worker: EAGAIN');
    insert('stopped', 'failed', 'Interrupted: the server stopped');
    insert('other', 'failed', 'Missing file in export: workout-routes/route_1.gpx');
    insert('ok', 'done', null);
    insert('cancelled', 'cancelled', null);
    const jobs = new JobManager(db, cfg, 'inline');
    const code = (id: string) => jobs.get(1, id)!.errorCode;
    expect(['crashed', 'exited', 'spawn'].map(code)).toEqual(['worker_crashed', 'worker_crashed', 'worker_crashed']);
    expect(code('stopped')).toBe('interrupted');
    expect(code('other')).toBe('failed');
    expect(code('ok')).toBeNull();
    expect(code('cancelled')).toBeNull();
    expect(jobErrorCode(null)).toBeNull();
    expect(jobErrorCode('Not resumed: local imports are disabled on this server')).toBe('not_resumed');
    expect(jobErrorCode('Source file is gone')).toBe('source_gone');
  });
});
