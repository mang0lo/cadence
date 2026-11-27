import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSample } from '../scripts/sample/generate';
import { migrateAll } from '../src/app';
import { all, get, openDb, type Db } from '../src/db/db';
import { CancelledError, DERIVE_VERSION } from '../src/derive/context';
import { JobManager } from '../src/import/jobs';
import { executeJob, type JobHooks } from '../src/import/run-job';
import { resetAthleteData } from '../src/import/reset';

/**
 * A cancelled, failed or interrupted import must not leave committed data underived: the next job (or the derive
 * JobManager queues) picks the changes up from the persisted derive scope (import/scope.ts).
 */
const noop: JobHooks = { progress: () => {}, checkCancelled: () => {}, log: () => {} };
let dir: string;
let zip: string;
let clean: Snapshot;
let dbs: Db[] = [];

type Snapshot = ReturnType<typeof snapshot>;

function snapshot(d: Db) {
  const n = (sql: string) => get<{ n: number | null }>(d, sql)!.n ?? 0;
  return {
    records: n('SELECT COUNT(*) AS n FROM records'),
    workouts: n('SELECT COUNT(*) AS n FROM workouts'),
    underived: n(`SELECT COUNT(*) AS n FROM workouts WHERE derived_version < ${DERIVE_VERSION}`),
    streams: n('SELECT COUNT(*) AS n FROM workout_streams'),
    polylines: n('SELECT COUNT(*) AS n FROM workouts WHERE polyline IS NOT NULL'),
    dailyMetrics: n('SELECT COUNT(*) AS n FROM daily_metrics'),
    dailyMetricsSum: Math.round(n('SELECT SUM(value) AS n FROM daily_metrics')),
    types: n('SELECT COUNT(*) AS n FROM record_type_stats'),
    typeCounts: n('SELECT SUM(count) AS n FROM record_type_stats'),
    sleepNights: n('SELECT COUNT(*) AS n FROM health_sleep_nights'),
    activity: n('SELECT SUM(count) AS n FROM daily_activity'),
  };
}

const pendingKeys = (d: Db) =>
  all<{ key: string }>(d, "SELECT key FROM settings WHERE key IN ('core.pendingDerive', 'core.deriveClaim')").map(
    (r) => r.key,
  );

function freshDb(name: string): Db {
  const d = openDb(path.join(dir, name));
  migrateAll(d);
  dbs.push(d);
  return d;
}

const importInto = (d: Db, hooks: JobHooks = noop) =>
  executeJob(d, { id: 'test', kind: 'import', athleteId: 1, sourcePath: zip, options: {} }, hooks);

/** Cancels the import as soon as `when` says so (checked wherever the job checks for a cancel). */
async function cancelledImport(d: Db, when: (d: Db, calls: number) => boolean): Promise<void> {
  let calls = 0;
  await expect(
    importInto(d, {
      ...noop,
      checkCancelled: () => {
        if (when(d, ++calls)) throw new CancelledError();
      },
    }),
  ).rejects.toBeInstanceOf(CancelledError);
  expect(d.isTransaction).toBe(false);
}

const rows = (d: Db, table: string) => get<{ n: number }>(d, `SELECT COUNT(*) AS n FROM ${table}`)!.n;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-recovery-'));
  zip = path.join(dir, 'export.zip');
  await generateSample({ out: zip, size: 'small', seed: 7, endDate: '2026-10-31' });
  const d = freshDb('clean.db');
  await importInto(d);
  clean = snapshot(d);
  expect(clean.dailyMetrics).toBeGreaterThan(500);
  expect(clean.sleepNights).toBeGreaterThan(30);
  expect(clean.underived).toBe(0);
  expect(pendingKeys(d)).toEqual([]);
}, 120_000);

afterAll(() => {
  for (const d of dbs) d.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('import after a cancelled import', () => {
  it('derives what a cancel while parsing export.xml left behind', async () => {
    const d = freshDb('parse.db');
    await cancelledImport(d, (_d, calls) => calls > 1);
    expect(rows(d, 'records')).toBeGreaterThan(0);
    expect(rows(d, 'records')).toBeLessThan(clean.records);
    expect(pendingKeys(d)).toEqual(['core.pendingDerive']);
    await importInto(d);
    expect(snapshot(d)).toEqual(clean);
    expect(pendingKeys(d)).toEqual([]);
  });

  it('derives what a cancel while reading workout routes left behind', async () => {
    const d = freshDb('routes.db');
    await cancelledImport(d, (db) => rows(db, 'workout_routes') > 0);
    expect(rows(d, 'daily_metrics')).toBe(0);
    const again = await importInto(d);
    expect(again.recordsInserted).toBe(0);
    expect(snapshot(d)).toEqual(clean);
  });

  it('derives what a cancel during the daily health metrics left behind', async () => {
    const d = freshDb('derive.db');
    await cancelledImport(d, (db) => rows(db, 'daily_metrics') > 0);
    // the derive had claimed the changes: they stay claimed for the next one
    expect(pendingKeys(d)).toEqual(['core.deriveClaim']);
    const again = await importInto(d);
    expect(again.recordsInserted).toBe(0);
    expect(again.workoutsInserted).toBe(0);
    expect(snapshot(d)).toEqual(clean);
    expect(pendingKeys(d)).toEqual([]);
  });
});

describe('pending changes', () => {
  it('are forgotten by a reset (the data they describe is gone)', async () => {
    const d = freshDb('reset.db');
    await cancelledImport(d, (_d, calls) => calls > 1);
    expect(pendingKeys(d)).toEqual(['core.pendingDerive']);
    resetAthleteData(d, 1);
    expect(pendingKeys(d)).toEqual([]);
  });
});

describe('job manager recovery', () => {
  const config = () => ({ dbPath: path.join(dir, 'unused.db'), uploadsDir: path.join(dir, 'uploads') });

  async function idle(jobs: JobManager): Promise<void> {
    for (let i = 0; i < 600 && jobs.busy(1); i++) await new Promise((r) => setTimeout(r, 25));
    expect(jobs.busy(1)).toBe(false);
  }

  it('derives the changes of an interrupted import when the server starts', async () => {
    const d = freshDb('restart.db');
    // the server stopped during the derive (nothing queued a new job)
    await cancelledImport(d, (db) => rows(db, 'daily_metrics') > 0);
    const jobs = new JobManager(d, config(), 'inline');
    jobs.start();
    const queued = all<{ options: string }>(d, "SELECT options FROM import_jobs WHERE kind = 'rederive'");
    expect(queued.map((r) => JSON.parse(r.options).origin)).toEqual(['recover']);
    await idle(jobs);
    expect(jobs.list(1)[0]).toMatchObject({ kind: 'rederive', status: 'done' });
    expect(snapshot(d)).toEqual(clean);
    expect(pendingKeys(d)).toEqual([]);
    await jobs.close();
    // nothing left to recover on the next start
    const again = new JobManager(d, config(), 'inline');
    again.start();
    expect(again.busy(1)).toBe(false);
    await again.close();
  });

  it('derives what a cancelled import committed right after the cancel', async () => {
    const d = freshDb('cancel.db');
    const jobs = new JobManager(d, config(), 'inline');
    jobs.start();
    const job = jobs.enqueueImport(1, zip, { options: { origin: 'local' } });
    const stop = jobs.onUpdate((j) => {
      if (j.id === job.id && j.phase === 'routes') jobs.cancel(1, job.id);
    });
    await idle(jobs);
    stop();
    const list = jobs.list(1);
    expect(list.map((j) => [j.kind, j.status])).toEqual([
      ['rederive', 'done'],
      ['import', 'cancelled'],
    ]);
    // every record and workout was committed before the routes: all of it is derived (without the routes it missed)
    const s = snapshot(d);
    expect(s.records).toBe(clean.records);
    expect(s.workouts).toBe(clean.workouts);
    expect(s.underived).toBe(0);
    expect(s.streams).toBe(clean.workouts);
    expect({ ...s, streams: 0, polylines: 0 }).toEqual({ ...clean, streams: 0, polylines: 0 });
    expect(pendingKeys(d)).toEqual([]);
    await jobs.close();
  });
});
