import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { applyPendingRestore, openWithPendingRestore } from '../src/core/backup-routes';
import { openDb, run, type Db } from '../src/db/db';

/** Four empty tables with the right names: what a web page could post to /api/backup/restore. */
function craftedDb(file: string): Buffer {
  const d = new DatabaseSync(file);
  d.exec(`CREATE TABLE _migrations(id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
          CREATE TABLE athletes(x); CREATE TABLE workouts(x); CREATE TABLE records(x);`);
  d.close();
  return fs.readFileSync(file);
}

/** What server.ts does on startup. */
function openMigrated(file: string): Db {
  const d = openDb(file);
  try {
    migrateAll(d);
    return d;
  } catch (e) {
    d.close();
    throw e;
  }
}

let dir: string;
let config: Config;
let db: Db;
let app: FastifyInstance;

function multipart(name: string, content: Buffer) {
  const boundary = '----cadence-test';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-backup-'));
  config = loadConfig({ CADENCE_DATA_DIR: path.join(dir, 'data'), CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
  db = openDb(config.dbPath);
  migrateAll(db);
  run(db, "UPDATE athletes SET name = 'Backup Tester' WHERE id = 1");
  app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('backup & restore', () => {
  it('downloads a consistent copy of the database', async () => {
    const res = await app.inject({ url: '/api/backup' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="cadence-backup-\d{4}-\d{2}-\d{2}\.db"/);
    const file = path.join(dir, 'downloaded.db');
    fs.writeFileSync(file, res.rawPayload);
    const copy = new DatabaseSync(file, { readOnly: true });
    expect((copy.prepare('SELECT name FROM athletes WHERE id = 1').get() as { name: string }).name).toBe('Backup Tester');
    copy.close();
    // the temporary snapshot is removed once the response stream closes
    const leftovers = () => fs.readdirSync(config.dataDir).filter((f) => f.startsWith('backup-'));
    for (let i = 0; i < 50 && leftovers().length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(leftovers()).toEqual([]);
  });

  it('leaves the logins of other services out of the backup', async () => {
    const secret = 'd41d8cd98f00b204e9800998ecf8427e-coros-password-hash';
    run(db, "INSERT INTO settings (athlete_id, key, value) VALUES (1, 'connect.coros', ?)", [
      JSON.stringify({ email: 'me@example.org', pwdMd5: secret, accessToken: 'token-123456789' }),
    ]);
    run(db, "INSERT INTO settings (athlete_id, key, value) VALUES (1, 'consistency.test', '\"kept\"')");
    run(db, "INSERT INTO settings (athlete_id, key, value) VALUES (1, 'core.sessions', ?)", [
      JSON.stringify([{ key: 'session-key-0123456789abcdef', exp: 9_999_999_999 }]),
    ]);
    const payload = (await app.inject({ url: '/api/backup' })).rawPayload;
    const file = path.join(dir, 'no-secrets.db');
    fs.writeFileSync(file, payload);
    const copy = new DatabaseSync(file, { readOnly: true });
    const keys = (copy.prepare('SELECT key FROM settings').all() as { key: string }[]).map((r) => r.key);
    copy.close();
    expect(keys).toContain('consistency.test');
    expect(keys).not.toContain('connect.coros');
    expect(keys).not.toContain('core.sessions'); // a restore logs everyone out
    // not in the freed pages of the file either
    expect(payload.includes(Buffer.from(secret))).toBe(false);
    expect(payload.includes(Buffer.from('token-123456789'))).toBe(false);
    expect(payload.includes(Buffer.from('session-key-0123456789abcdef'))).toBe(false);
    // the running database keeps the login
    expect(db.prepare("SELECT 1 AS x FROM settings WHERE key = 'connect.coros'").get()).toBeTruthy();
    run(db, "DELETE FROM settings WHERE key IN ('connect.coros', 'consistency.test', 'core.sessions')");
  });

  it('rejects files that are not Cadence databases', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/backup/restore', ...multipart('x.db', Buffer.from('not sqlite')) });
    expect(res.statusCode).toBe(400);
    expect(fs.existsSync(`${config.dbPath}.restore`)).toBe(false);
    // the right table names alone do not make a backup
    const crafted = craftedDb(path.join(dir, 'crafted.db'));
    const res2 = await app.inject({ method: 'POST', url: '/api/backup/restore', ...multipart('c.db', crafted) });
    expect(res2.statusCode).toBe(400);
    expect(fs.existsSync(`${config.dbPath}.restore`)).toBe(false);
  });

  it('goes back to the previous database when a restored one cannot be opened', () => {
    for (const bad of ['crafted', 'garbage'] as const) {
      const folder = path.join(dir, `bad-restore-${bad}`);
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, 'cadence.db');
      const before = openMigrated(file);
      run(before, "UPDATE athletes SET name = 'Before' WHERE id = 1");
      before.close();
      if (bad === 'crafted') craftedDb(`${file}.restore`);
      else fs.writeFileSync(`${file}.restore`, 'this is not a database file at all, just text '.repeat(200));
      const logs: string[] = [];
      const reopened = openWithPendingRestore(file, openMigrated, (m) => logs.push(m));
      try {
        expect((reopened.prepare('SELECT name FROM athletes WHERE id = 1').get() as { name: string }).name).toBe('Before');
      } finally {
        reopened.close();
      }
      const files = fs.readdirSync(folder);
      expect(files.some((f) => f.startsWith('cadence.db.failed-restore-')), bad).toBe(true);
      expect(files.some((f) => f.startsWith('cadence.db.before-restore-')), bad).toBe(false);
      expect(files).not.toContain('cadence.db.restore');
      expect(logs.join(' ')).toMatch(/could not be opened/);
      // the next start is a normal one
      const again = openWithPendingRestore(file, openMigrated, () => {});
      again.close();
    }
  });

  it('brings back exactly the database from before the failed restore, not an older one', () => {
    const folder = path.join(dir, 'bad-restore-exact');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'cadence.db');
    const name = (d: Db) => (d.prepare('SELECT name FROM athletes WHERE id = 1').get() as { name: string }).name;
    // left over from an earlier restore, with a name that sorts last (the clock was wrong back then)
    const staleFile = `${file}.before-restore-2999-01-01T00-00-00-000Z`;
    const stale = openMigrated(staleFile);
    run(stale, "UPDATE athletes SET name = 'Stale' WHERE id = 1");
    stale.close();
    const before = openMigrated(file);
    run(before, "UPDATE athletes SET name = 'Before' WHERE id = 1");
    before.close();
    fs.writeFileSync(`${file}.restore`, 'not a database '.repeat(200));
    const reopened = openWithPendingRestore(file, openMigrated, () => {});
    try {
      expect(name(reopened)).toBe('Before');
    } finally {
      reopened.close();
    }
    // no database before the restore: a new one, and the older file stays where it is
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    fs.writeFileSync(`${file}.restore`, 'not a database '.repeat(200));
    const fresh = openWithPendingRestore(file, openMigrated, () => {});
    try {
      expect(name(fresh)).toBe('Athlete');
    } finally {
      fresh.close();
    }
    expect(fs.existsSync(staleFile)).toBe(true);
  });

  it('stages a valid backup and swaps it in on the next start', async () => {
    const backup = (await app.inject({ url: '/api/backup' })).rawPayload;
    const res = await app.inject({ method: 'POST', url: '/api/backup/restore', ...multipart('b.db', backup) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, restarting: false }); // dev mode never restarts itself
    expect(fs.existsSync(`${config.dbPath}.restore`)).toBe(true);

    const other = path.join(dir, 'other', 'cadence.db');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, 'old');
    fs.copyFileSync(`${config.dbPath}.restore`, `${other}.restore`);
    expect(applyPendingRestore(other)).toBe(true);
    expect(fs.existsSync(`${other}.restore`)).toBe(false);
    expect(fs.readdirSync(path.dirname(other)).some((f) => f.startsWith('cadence.db.before-restore-'))).toBe(true);
    const restored = new DatabaseSync(other, { readOnly: true });
    expect((restored.prepare('SELECT name FROM athletes WHERE id = 1').get() as { name: string }).name).toBe('Backup Tester');
    restored.close();
    expect(applyPendingRestore(other)).toBe(false);
  });
});
