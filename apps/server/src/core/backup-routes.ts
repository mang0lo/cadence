import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { HttpError, badRequest } from '../lib/http';

/**
 * Backup & restore of the complete database — the way to move from the Mac app to a server (or back)
 * without losing anything that is not in the Apple Health export (renamed activities, goals, segments …).
 */

/** Exit code that asks the macOS shell (and Docker's restart policy) to start the server again. */
export const RESTART_EXIT_CODE = 75;

const restorePath = (dbPath: string) => `${dbPath}.restore`;

/** Called on startup before the database is opened: swaps in a pending restore, keeping the old file. */
export function applyPendingRestore(dbPath: string): boolean {
  const pending = restorePath(dbPath);
  if (!fs.existsSync(pending)) return false;
  if (fs.existsSync(dbPath)) {
    const old = `${dbPath}.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(dbPath, old);
    for (const ext of ['-wal', '-shm']) if (fs.existsSync(dbPath + ext)) fs.renameSync(dbPath + ext, old + ext);
  }
  fs.renameSync(pending, dbPath);
  return true;
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
    const check = Object.values(db.prepare('PRAGMA quick_check').get() as Record<string, unknown>)[0];
    if (check !== 'ok') throw badRequest('The backup file is damaged');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw badRequest('This file is not a Cadence backup');
  } finally {
    db?.close();
  }
}

/** GET /api/backup, POST /api/backup/restore */
export default async function backupRoutes(app: FastifyInstance) {
  // Consistent snapshot: VACUUM INTO works while imports and readers are running.
  app.get('/backup', async (_req, reply) => {
    const tmp = path.join(app.config.dataDir, `backup-${process.pid}-${Date.now()}.db`);
    app.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
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
    if (restarting) setTimeout(() => process.kill(process.pid, 'SIGUSR2'), 300).unref();
    return { ok: true, restarting };
  });
}
