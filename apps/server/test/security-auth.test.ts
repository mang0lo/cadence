import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb, type Db } from '../src/db/db';

/** One request over a real socket, the target sent exactly as given (absolute-form, %-escapes). */
function raw(
  port: number,
  method: string,
  target: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type'] ?? ''), body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('password check on every /api route, however the path is spelled', () => {
  let dir: string;
  let db: Db;
  let app: FastifyInstance;
  let port: number;
  const bearer = { authorization: 'Bearer correct horse' };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-sec-auth-'));
    const web = path.join(dir, 'web');
    fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>Cadence</title>');
    fs.writeFileSync(path.join(web, 'assets', 'app.js'), 'console.log(1)');
    const config = loadConfig({
      CADENCE_DATA_DIR: path.join(dir, 'data'),
      CADENCE_WEB_DIR: web,
      CADENCE_MODE: 'server',
      CADENCE_PASSWORD: 'correct horse',
      LOG_LEVEL: 'silent',
    });
    db = openDb(config.dbPath);
    migrateAll(db);
    app = await buildApp(config, db, { jobRunner: 'inline' });
    await app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects percent-encoded spellings of /api routes', async () => {
    for (const url of ['/%61pi/workouts', '/ap%69/settings', '/%61pi/athlete', '/api/%62ackup', '/%61%70%69/sources']) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(401);
    }
    expect((await app.inject({ method: 'HEAD', url: '/%61pi/backup' })).statusCode).toBe(401);
    const patch = await app.inject({ method: 'PATCH', url: '/%61pi/athlete', payload: { name: 'Mallory' } });
    expect(patch.statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/%61pi/import/reset', payload: { confirm: 'DELETE' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/%61pi/consistency/goals' })).statusCode).toBe(401);
    // still works with the password
    expect((await app.inject({ url: '/%61pi/workouts', headers: bearer })).statusCode).toBe(200);
  });

  it('rejects absolute-form request targets (over a real socket)', async () => {
    for (const target of ['http://x/api/workouts', 'HTTP://x/%61pi/workouts?x=1', 'https://x/api/backup']) {
      const res = await raw(port, 'GET', target);
      expect(res.status, target).toBe(401);
    }
    expect((await raw(port, 'HEAD', 'http://x/api/backup')).status).toBe(401);
    expect((await raw(port, 'PATCH', 'http://x/api/settings', { 'content-type': 'application/json' })).status).toBe(401);
    expect((await raw(port, 'GET', '/%61pi/athlete')).status).toBe(401);
    expect((await raw(port, 'GET', 'http://x/api/workouts', bearer)).status).toBe(200);
  });

  it('never answers other spellings with API data', async () => {
    for (const url of ['//api/workouts', '/API/workouts', '/Api/settings', '/api%2Fworkouts', '/api/workouts/']) {
      const res = await raw(port, 'GET', url);
      // the SPA page, a 404 or a login prompt — never the API's JSON
      expect([200, 401, 404], url).toContain(res.status);
      if (res.status === 200) expect(res.type, url).toMatch(/^text\/html/);
    }
  });

  it('keeps status, login, logout, the web app and unknown API paths as before', async () => {
    for (const url of ['/api/status', '/api/status?x=1', '/%61pi/status']) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(200);
      expect(res.json().authRequired).toBe(true);
    }
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'nope' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout' })).statusCode).toBe(200);
    for (const url of ['/', '/assets/app.js', '/activities/123']) {
      expect((await app.inject({ url })).statusCode, url).toBe(200);
    }
    expect((await app.inject({ url: '/activities/123' })).headers['content-type']).toMatch(/^text\/html/);
    // unknown API paths ask for a login first, and are 404 with it
    expect((await app.inject({ url: '/api/nope' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/nope', headers: bearer })).statusCode).toBe(404);
  });
});
