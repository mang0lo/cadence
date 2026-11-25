import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db/db';

async function server(env: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-sec-proxy-'));
  const config = loadConfig({ CADENCE_DATA_DIR: path.join(dir, 'data'), LOG_LEVEL: 'silent', ...env });
  const db = openDb(config.dbPath);
  migrateAll(db);
  const app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();
  const login = (password: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { password }, headers });
  const close = async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { app, login, close };
}

const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie'] ?? '');

describe('behind a reverse proxy', () => {
  it('with CADENCE_TRUST_PROXY: wrong passwords lock out one client, not everyone, and https gives a Secure cookie', async () => {
    // inject connects from 127.0.0.1: here that is the proxy
    const s = await server({ CADENCE_MODE: 'server', CADENCE_PASSWORD: 'pw', CADENCE_TRUST_PROXY: '127.0.0.1' });
    try {
      const attacker = { 'x-forwarded-for': '203.0.113.7' };
      for (let i = 0; i < 8; i++) expect((await s.login(`guess ${i}`, attacker)).statusCode).toBe(401);
      expect((await s.login('pw', attacker)).statusCode).toBe(429);
      const owner = await s.login('pw', { 'x-forwarded-for': '198.51.100.9', 'x-forwarded-proto': 'https' });
      expect(owner.statusCode).toBe(200);
      expect(cookieOf(owner)).toMatch(/; Secure/);
      // IPv6 clients count per /64: a new address in the same network gets no fresh attempts
      for (let i = 0; i < 8; i++) {
        expect((await s.login('nope', { 'x-forwarded-for': `2001:db8:1:2::${i + 1}` })).statusCode).toBe(401);
      }
      expect((await s.login('pw', { 'x-forwarded-for': '2001:db8:1:2:ffff::9' })).statusCode).toBe(429);
    } finally {
      await s.close();
    }
  });

  it('without it: forwarded headers are not believed', async () => {
    const s = await server({ CADENCE_MODE: 'server', CADENCE_PASSWORD: 'pw' });
    try {
      // a client cannot claim https or a fresh address for itself
      const plain = await s.login('pw', { 'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.9' });
      expect(plain.statusCode).toBe(200);
      expect(cookieOf(plain)).not.toMatch(/Secure/);
      for (let i = 0; i < 8; i++) {
        expect((await s.login('nope', { 'x-forwarded-for': `203.0.113.${i}` })).statusCode).toBe(401);
      }
      expect((await s.login('pw', { 'x-forwarded-for': '203.0.113.99' })).statusCode).toBe(429);
    } finally {
      await s.close();
    }
  });

  it('gives a Secure cookie to a page served over https, also through a proxy that is not configured', async () => {
    const s = await server({ CADENCE_MODE: 'server', CADENCE_PASSWORD: 'pw' });
    try {
      const page = { host: 'cadence.example.org', origin: 'https://cadence.example.org', 'sec-fetch-site': 'same-origin' };
      const res = await s.login('pw', page);
      expect(res.statusCode).toBe(200);
      expect(cookieOf(res)).toMatch(/HttpOnly; SameSite=Lax; .*; Secure/);
      // plain http pages (the desktop app, a LAN server) keep a cookie the browser sends over http
      const http = await s.login('pw', { host: '192.168.1.20:8787', origin: 'http://192.168.1.20:8787' });
      expect(http.statusCode).toBe(200);
      expect(cookieOf(http)).not.toMatch(/Secure/);
    } finally {
      await s.close();
    }
  });
});
