import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { applyPendingRestore } from '../src/core/backup-routes';
import { openDb, run, type Db } from '../src/db/db';

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
    const payload = (await app.inject({ url: '/api/backup' })).rawPayload;
    const file = path.join(dir, 'no-secrets.db');
    fs.writeFileSync(file, payload);
    const copy = new DatabaseSync(file, { readOnly: true });
    const keys = (copy.prepare('SELECT key FROM settings').all() as { key: string }[]).map((r) => r.key);
    copy.close();
    expect(keys).toContain('consistency.test');
    expect(keys).not.toContain('connect.coros');
    // not in the freed pages of the file either
    expect(payload.includes(Buffer.from(secret))).toBe(false);
    expect(payload.includes(Buffer.from('token-123456789'))).toBe(false);
    // the running database keeps the login
    expect(db.prepare("SELECT 1 AS x FROM settings WHERE key = 'connect.coros'").get()).toBeTruthy();
    run(db, "DELETE FROM settings WHERE key IN ('connect.coros', 'consistency.test')");
  });

  it('rejects files that are not Cadence databases', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/backup/restore', ...multipart('x.db', Buffer.from('not sqlite')) });
    expect(res.statusCode).toBe(400);
    expect(fs.existsSync(`${config.dbPath}.restore`)).toBe(false);
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
