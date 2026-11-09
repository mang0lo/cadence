import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { LoginThrottle } from '../src/core/auth';
import { openDb, type Db } from '../src/db/db';

describe('login throttle', () => {
  it('locks an address out after repeated wrong passwords, for a while', () => {
    let now = 1_000_000;
    const t = new LoginThrottle(() => now);
    for (let i = 0; i < 7; i++) t.fail('1.2.3.4');
    expect(t.retryAfterS('1.2.3.4')).toBe(0);
    t.fail('1.2.3.4');
    expect(t.retryAfterS('1.2.3.4')).toBe(300);
    // other addresses are not affected
    expect(t.retryAfterS('5.6.7.8')).toBe(0);
    now += 299_000;
    expect(t.retryAfterS('1.2.3.4')).toBe(1);
    now += 2_000;
    expect(t.retryAfterS('1.2.3.4')).toBe(0);
  });

  it('forgets old failures and resets on a successful login', () => {
    let now = 0;
    const t = new LoginThrottle(() => now);
    for (let i = 0; i < 7; i++) t.fail('a');
    t.succeed('a');
    for (let i = 0; i < 7; i++) t.fail('a');
    expect(t.retryAfterS('a')).toBe(0);
    // seven old failures, then one more after the window: no lock
    now += 16 * 60_000;
    t.fail('a');
    expect(t.retryAfterS('a')).toBe(0);
  });
});

describe('password protected server', () => {
  let dir: string;
  let db: Db;
  let app: FastifyInstance;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-auth-'));
    const config = loadConfig({
      CADENCE_DATA_DIR: path.join(dir, 'data'),
      CADENCE_MODE: 'server',
      CADENCE_PASSWORD: 'correct horse',
      LOG_LEVEL: 'silent',
    });
    db = openDb(config.dbPath);
    migrateAll(db);
    app = await buildApp(config, db, { jobRunner: 'inline' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const login = (password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { password } });

  it('needs a login for the API and sets baseline security headers', async () => {
    const res = await app.inject({ url: '/api/workouts' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect((await app.inject({ url: '/api/status' })).statusCode).toBe(200);
  });

  it('logs in with the password (cookie) or a Bearer header', async () => {
    const ok = await login('correct horse');
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers['set-cookie']).split(';')[0]!;
    expect((await app.inject({ url: '/api/workouts', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/workouts', headers: { authorization: 'Bearer correct horse' } })).statusCode).toBe(200);
  });

  it('answers 429 after too many wrong passwords, also for the right one, while logged-in sessions keep working', async () => {
    const cookie = String((await login('correct horse')).headers['set-cookie']).split(';')[0]!;
    for (let i = 0; i < 8; i++) expect((await login(`guess ${i}`)).statusCode).toBe(401);
    const blocked = await login('correct horse');
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.json().error.code).toBe('too_many_attempts');
    expect((await app.inject({ url: '/api/workouts', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/workouts', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(429);
  });
});
