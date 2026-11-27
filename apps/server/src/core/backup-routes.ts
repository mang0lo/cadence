import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
import type { FastifyInstance } from 'fastify';
import { get, type Db } from '../db/db';
import { features } from '../features';
import { HttpError, badRequest } from '../lib/http';

/**
 * Backup & restore of the complete database — the way to move from the Mac app to a server (or back)
 * without losing anything that is not in the Apple Health export (renamed activities, goals, segments …).
 */

const restorePath = (dbPath: string) => `${dbPath}.restore`;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** Renames a database file together with its -wal / -shm files. */
function moveDb(from: string, to: string): void {
  fs.renameSync(from, to);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(from + ext)) fs.renameSync(from + ext, to + ext);
}

/**
 * Swaps in a pending restore, keeping the old file: returns where the previous database went ('' when there was
 * none), null when no restore is pending.
 */
function swapInRestore(dbPath: string): string | null {
  const pending = restorePath(dbPath);
  if (!fs.existsSync(pending)) return null;
  let previous = '';
  if (fs.existsSync(dbPath)) moveDb(dbPath, (previous = `${dbPath}.before-restore-${stamp()}`));
  fs.renameSync(pending, dbPath);
  return previous;
}

/** Called on startup before the database is opened: swaps in a pending restore, keeping the old file. */
export function applyPendingRestore(dbPath: string): boolean {
  return swapInRestore(dbPath) !== null;
}

/**
 * Opens the database on startup (`open` opens and migrates it), applying a pending restore first. A restored file
 * that cannot be opened or migrated is kept aside as <db>.failed-restore-<time> and the database from before the
 * restore comes back (exactly that one, not an older before-restore file): a bad backup must never keep the app from
 * starting.
 */
export function openWithPendingRestore<T>(dbPath: string, open: (file: string) => T, log: (msg: string) => void = console.log): T {
  const previous = swapInRestore(dbPath);
  if (previous === null) return open(dbPath);
  try {
    const db = open(dbPath);
    log('Restored the database from an uploaded backup');
    return db;
  } catch (e) {
    log(`The uploaded backup could not be opened (${(e as Error).message}); the previous database is used again`);
    moveDb(dbPath, `${dbPath}.failed-restore-${stamp()}`);
    if (previous) moveDb(previous, dbPath);
    return open(dbPath);
  }
}

function validateBackup(file: string): void {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const { n } = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master
         WHERE type = 'table' AND name IN ('_migrations', 'athletes', 'workouts', 'records')`,
      )
      .get() as { n: number };
    if (n !== 4) throw badRequest('This file is not a Cadence backup');
    // written by Cadence's own migrations, not just four tables with the right names
    if (!db.prepare("SELECT 1 FROM _migrations WHERE id = 'core_001_init'").get())
      throw badRequest('This file is not a Cadence backup');
    const check = Object.values(db.prepare('PRAGMA quick_check').get() as Record<string, unknown>)[0];
    if (check !== 'ok') throw badRequest('The backup file is damaged');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw badRequest('This file is not a Cadence backup');
  } finally {
    db?.close();
  }
}

/**
 * Remove the logins of other services (Feature.secretSettings) and the server's own login sessions from a backup
 * copy (a restore logs everyone out). secure_delete overwrites the freed pages, so the values are not left behind.
 */
export function stripSecrets(file: string): void {
  const keys = ['core.sessions', ...features.flatMap((f) => f.secretSettings ?? [])];
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA secure_delete = ON');
    db.prepare(`DELETE FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`).run(...keys);
  } finally {
    db.close();
  }
}

/** VACUUM INTO on a read-only connection of its own, in a worker thread (plain JS: the same in tsx and the bundle). */
const SNAPSHOT_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let db;
try {
  db = new DatabaseSync(workerData.source, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 15000');
  db.exec("VACUUM INTO '" + workerData.target.replace(/'/g, "''") + "'");
  parentPort.postMessage({ ok: true });
} catch (e) {
  parentPort.postMessage({ ok: false, message: e instanceof Error ? e.message : String(e) });
} finally {
  if (db) db.close();
}`;

/**
 * Consistent snapshot of the database into `target`: VACUUM INTO works while imports and readers are running, and
 * in a worker it does not stop the server for the seconds a large database takes.
 */
function snapshot(db: Db, target: string): Promise<void> {
  const source = get<{ file: string }>(db, "SELECT file FROM pragma_database_list WHERE name = 'main'")?.file;
  if (!source) {
    // in-memory database (tests): no other connection can see it
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(SNAPSHOT_WORKER, { eval: true, workerData: { source, target } });
    worker.once('message', (m: { ok: boolean; message?: string }) => (m.ok ? resolve() : reject(new Error(m.message))));
    worker.once('error', reject);
    worker.once('exit', (code) => reject(new Error(`The backup stopped unexpectedly (code ${code})`)));
  });
}

/**
 * The snapshot being made or downloaded. One at a time: a backup is a copy of the whole database, so parallel
 * requests (a double click) get the same file while it is fresh; later ones are told to wait (409) until the
 * download that still holds it has finished.
 */
interface Snapshot {
  file: string;
  /** Size in bytes once the file is complete. */
  ready: Promise<number>;
  readers: number;
  madeAt: number | null;
}
const SHARE_MS = 30_000;

/** GET /api/backup, POST /api/backup/restore */
export default async function backupRoutes(app: FastifyInstance) {
  let current: Snapshot | null = null;
  app.get('/backup', async (_req, reply) => {
    let snap = current;
    if (snap && snap.madeAt !== null && Date.now() - snap.madeAt > SHARE_MS) {
      throw new HttpError(409, 'busy', 'Another backup download is still running. Try again when it has finished.');
    }
    if (!snap) {
      const file = path.join(app.config.dataDir, `backup-${process.pid}-${Date.now()}.db`);
      const made: Snapshot = { file, readers: 0, madeAt: null, ready: Promise.resolve(0) };
      made.ready = snapshot(app.db, file).then(() => {
        stripSecrets(file);
        made.madeAt = Date.now();
        return fs.statSync(file).size;
      });
      current = snap = made;
    }
    const s = snap;
    s.readers++;
    const release = () => {
      if (--s.readers > 0) return;
      if (current === s) current = null;
      fs.rm(s.file, { force: true }, () => undefined);
    };
    let size: number;
    try {
      size = await s.ready;
    } catch (e) {
      release();
      throw e;
    }
    const stream = fs.createReadStream(s.file);
    stream.on('close', release);
    reply.header('content-type', 'application/vnd.sqlite3');
    reply.header('content-length', size);
    reply.header('content-disposition', `attachment; filename="cadence-backup-${new Date().toISOString().slice(0, 10)}.db"`);
    return reply.send(stream);
  });

  // Upload a backup; it replaces the database on the next start (the server restarts itself
  // in desktop/server mode — the macOS shell and Docker bring it back up).
  app.post('/backup/restore', async (req) => {
    if (app.jobs.busy(req.athleteId)) throw new HttpError(409, 'busy', 'Wait until the running import has finished');
    if (!req.isMultipart()) throw badRequest('Expected multipart/form-data with a backup file');
    const file = await req.file();
    if (!file) throw badRequest('No file in upload');
    const tmp = `${restorePath(app.config.dbPath)}.upload`;
    try {
      await pipeline(file.file, fs.createWriteStream(tmp));
      validateBackup(tmp);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    fs.renameSync(tmp, restorePath(app.config.dbPath));
    const restarting = app.config.mode !== 'dev';
    // emit instead of kill: Windows has no SIGUSR2 signal, the handler in server.ts runs either way
    if (restarting) setTimeout(() => process.emit('SIGUSR2'), 300).unref();
    return { ok: true, restarting };
  });
}
