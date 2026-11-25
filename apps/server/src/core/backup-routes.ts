import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { features } from '../features';
import { HttpError, badRequest } from '../lib/http';

/**
 * Backup & restore of the complete database — the way to move from the Mac app to a server (or back)
 * without losing anything that is not in the Apple Health export (renamed activities, goals, segments …).
 */

/** Exit code that asks the macOS shell (and Docker's restart policy) to start the server again. */
export const RESTART_EXIT_CODE = 75;

const restorePath = (dbPath: string) => `${dbPath}.restore`;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** Renames a database file together with its -wal / -shm files. */
function moveDb(from: string, to: string): void {
  fs.renameSync(from, to);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(from + ext)) fs.renameSync(from + ext, to + ext);
}

/** Called on startup before the database is opened: swaps in a pending restore, keeping the old file. */
export function applyPendingRestore(dbPath: string): boolean {
  const pending = restorePath(dbPath);
  if (!fs.existsSync(pending)) return false;
  if (fs.existsSync(dbPath)) moveDb(dbPath, `${dbPath}.before-restore-${stamp()}`);
  fs.renameSync(pending, dbPath);
  return true;
}

/**
 * Opens the database on startup (`open` opens and migrates it), applying a pending restore first. A restored file
 * that cannot be opened or migrated is kept aside as <db>.failed-restore-<time> and the database from before the
 * restore comes back: a bad backup must never keep the app from starting.
 */
export function openWithPendingRestore<T>(dbPath: string, open: (file: string) => T, log: (msg: string) => void = console.log): T {
  if (!applyPendingRestore(dbPath)) return open(dbPath);
  try {
    const db = open(dbPath);
    log('Restored the database from an uploaded backup');
    return db;
  } catch (e) {
    log(`The uploaded backup could not be opened (${(e as Error).message}); the previous database is used again`);
    moveDb(dbPath, `${dbPath}.failed-restore-${stamp()}`);
    const dir = path.dirname(dbPath);
    const prefix = `${path.basename(dbPath)}.before-restore-`;
    const previous = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && !/-(wal|shm)$/.test(f))
      .sort()
      .pop();
    if (previous) moveDb(path.join(dir, previous), dbPath);
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
 * Remove the logins of other services (Feature.secretSettings) from a backup copy. secure_delete overwrites the
 * freed pages, so the values are not left behind in the file.
 */
export function stripSecrets(file: string): void {
  const keys = features.flatMap((f) => f.secretSettings ?? []);
  if (!keys.length) return;
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA secure_delete = ON');
    db.prepare(`DELETE FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`).run(...keys);
  } finally {
    db.close();
  }
}

/** GET /api/backup, POST /api/backup/restore */
export default async function backupRoutes(app: FastifyInstance) {
  // Consistent snapshot: VACUUM INTO works while imports and readers are running.
  app.get('/backup', async (_req, reply) => {
    const tmp = path.join(app.config.dataDir, `backup-${process.pid}-${Date.now()}.db`);
    app.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    try {
      stripSecrets(tmp);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    const size = fs.statSync(tmp).size;
    const stream = fs.createReadStream(tmp);
    stream.on('close', () => fs.rm(tmp, { force: true }, () => undefined));
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
