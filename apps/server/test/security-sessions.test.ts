import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { Sessions } from '../src/core/auth';
import { openDb, type Db } from '../src/db/db';

describe('login sessions', () => {
  let dir: string;
  let db: Db;
  let app: FastifyInstance;

  const build = async (password: string) => {
    const config = loadConfig({
      CADENCE_DATA_DIR: path.join(dir, 'data'),
      CADENCE_MODE: 'server',
      CADENCE_PASSWORD: password,
      LOG_LEVEL: 'silent',
    });
    const a = await buildApp(config, db, { jobRunner: 'inline' });
    await a.ready();
    return a;
  };
  const login = async (a: FastifyInstance, password = 'correct horse') => {
    const res = await a.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });
    expect(res.statusCode).toBe(200);
    return String(res.headers['set-cookie']).split(';')[0]!;
  };
  const status = async (a: FastifyInstance, cookie: string) =>
    (await a.inject({ url: '/api/workouts', headers: { cookie } })).statusCode;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-sessions-'));
    db = openDb(path.join(dir, 'data', 'cadence.db'));
    migrateAll(db);
    app = await build('correct horse');
  });

  afterAll(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gives every login its own random cookie that says nothing about the password', async () => {
    const a = await login(app);
    const b = await login(app);
    expect(a).not.toBe(b);
    expect(await status(app, a)).toBe(200);
    expect(await status(app, b)).toBe(200);
    // the cookie of earlier versions (an HMAC of the password: crackable offline, valid forever) is not accepted
    const v1 = createHmac('sha256', 'correct horse').update('cadence-session-v1').digest('hex');
    expect(a).not.toContain(v1);
    expect(await status(app, `cadence_auth=${v1}`)).toBe(401);
    // the database keeps no usable cookie either
    const stored = String((db.prepare("SELECT value FROM settings WHERE key = 'core.sessions'").get() as { value: string }).value);
    expect(stored).not.toContain(a.split('=')[1]!);
  });

  it('ends the session on logout, on this device only', async () => {
    const a = await login(app);
    const b = await login(app);
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: a } });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect(await status(app, a)).toBe(401);
    expect(await status(app, b)).toBe(200);
    expect((await app.inject({ url: '/api/status', headers: { cookie: a } })).json().authenticated).toBe(false);
  });

  it('ends every session when the password changes', async () => {
    const a = await login(app);
    const other = await build('battery staple');
    try {
      expect(await status(other, a)).toBe(401);
      expect(await status(other, await login(other, 'battery staple'))).toBe(200);
    } finally {
      await other.close();
    }
  });

  it('expires sessions after 30 days and keeps the list bounded', () => {
    let now = 1_800_000_000_000;
    const s = new Sessions(db, 'pw', () => now);
    const t = s.create();
    expect(s.valid(t)).toBe(true);
    expect(s.valid(`${t}x`)).toBe(false);
    now += 29 * 86_400_000;
    expect(s.valid(t)).toBe(true);
    now += 2 * 86_400_000;
    expect(s.valid(t)).toBe(false);
    const tokens = Array.from({ length: 105 }, () => s.create());
    expect(s.valid(tokens[0]!)).toBe(false); // the oldest made room
    expect(s.valid(tokens[104]!)).toBe(true);
  });
});
