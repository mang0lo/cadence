import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { clientKey, hostAllowed } from '../src/core/auth';
import { openDb, type Db } from '../src/db/db';

function multipart(content: Buffer) {
  const boundary = '----cadence-guard';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="evil.db"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, content, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function server(env: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-sec-guard-'));
  const config = loadConfig({ CADENCE_DATA_DIR: path.join(dir, 'data'), LOG_LEVEL: 'silent', ...env });
  const db = openDb(config.dbPath);
  migrateAll(db);
  const app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();
  const close = async () => {
    await app.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { app, db, config, close };
}

describe('desktop server without a password: other websites', () => {
  let app: FastifyInstance;
  let db: Db;
  let config: Config;
  let close: () => Promise<void>;
  const local = { host: '127.0.0.1:52100' };
  const restoreFile = () => fs.existsSync(`${config.dbPath}.restore`);

  beforeAll(async () => {
    ({ app, db, config, close } = await server({ CADENCE_MODE: 'desktop' }));
  });
  afterAll(() => close());

  it('cannot read the API under a rebound host name', async () => {
    for (const host of ['rebind.attacker.example:52100', 'attacker.example', 'localhost.attacker.example:80']) {
      const res = await app.inject({ url: '/api/backup', headers: { host } });
      expect(res.statusCode, host).toBe(403);
      expect(res.json().error.code).toBe('forbidden_host');
    }
    expect((await app.inject({ url: '/api/status', headers: { host: 'attacker.example' } })).statusCode).toBe(403);
    // the shells, the browser, the Vite proxy and the tests use local names
    for (const host of ['127.0.0.1:52100', 'localhost:5173', '[::1]:8787', 'cadence.localhost', 'LOCALHOST', '192.168.1.20:8787']) {
      expect((await app.inject({ url: '/api/athlete', headers: { host } })).statusCode, host).toBe(200);
    }
    expect((await app.inject({ url: '/api/athlete' })).statusCode).toBe(200); // inject: localhost:80
  });

  it('cannot post a restore or an upload from another site', async () => {
    const evil = multipart(Buffer.from('SQLite format 3\0'));
    const attempts: Record<string, string>[] = [
      { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' },
      { origin: 'http://localhost:9216', 'sec-fetch-site': 'same-site' }, // another local dev server
      { origin: 'https://attacker.example' }, // a browser without Fetch Metadata
      { origin: 'null' },
    ];
    for (const h of attempts) {
      for (const url of ['/api/backup/restore', '/api/import/upload']) {
        const res = await app.inject({ method: 'POST', url, ...evil, headers: { ...evil.headers, ...local, ...h } });
        expect(res.statusCode, `${url} ${JSON.stringify(h)}`).toBe(403);
        expect(res.json().error.code).toBe('cross_site_request');
      }
    }
    expect(restoreFile()).toBe(false);
    // bodiless and JSON writes as well
    const sync = await app.inject({
      method: 'POST',
      url: '/api/import/rederive',
      headers: { ...local, origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(sync.statusCode).toBe(403);
  });

  it('still takes writes from its own pages and from scripts', async () => {
    const own = { ...local, origin: 'http://127.0.0.1:52100' };
    // same origin with and without Fetch Metadata, user-typed (none), and curl (neither header)
    for (const h of [{ ...own, 'sec-fetch-site': 'same-origin' }, own, { ...local, 'sec-fetch-site': 'none' }, local]) {
      const res = await app.inject({ method: 'PATCH', url: '/api/athlete', headers: h, payload: { name: 'Me' } });
      expect(res.statusCode, JSON.stringify(h)).toBe(200);
    }
    // Vite dev server: proxied with the browser's Host (changeOrigin: false)
    const vite = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
      payload: { theme: 'dark' },
    });
    expect(vite.statusCode).toBe(200);
    // a same-origin restore reaches the handler (here: rejected as no backup)
    const res = await app.inject({
      method: 'POST',
      url: '/api/backup/restore',
      ...multipart(Buffer.from('not sqlite')),
      headers: { ...multipart(Buffer.from('')).headers, ...own, 'sec-fetch-site': 'same-origin' },
    });
    expect(res.statusCode).toBe(400);
    // reading from another site's links (images, downloads) is not blocked: only the Host matters there
    expect((await app.inject({ url: '/api/athlete', headers: { ...local, 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(200);
    expect(db).toBeTruthy();
  });
});

describe('server mode', () => {
  it('answers to any host name with a password, and still blocks other sites', async () => {
    const s = await server({ CADENCE_MODE: 'server', CADENCE_PASSWORD: 'pw' });
    try {
      const auth = { authorization: 'Bearer pw' };
      const res = await s.app.inject({ url: '/api/athlete', headers: { ...auth, host: 'cadence.example.org' } });
      expect(res.statusCode).toBe(200);
      const csrf = await s.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { host: 'cadence.example.org', origin: 'https://evil.example', cookie: 'cadence_auth=x' },
        payload: { units: 'imperial' },
      });
      expect(csrf.statusCode).toBe(403);
      // the site's own page (https at a proxy: Origin https://…, Host as forwarded)
      const own = await s.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { ...auth, host: 'cadence.example.org', origin: 'https://cadence.example.org' },
        payload: { units: 'imperial' },
      });
      expect(own.statusCode).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('does not let a rebinding page name a local host in X-Forwarded-Host when a loopback proxy is trusted', async () => {
    // inject connects from 127.0.0.1, like a browser on this machine that reaches the server directly
    const s = await server({ CADENCE_MODE: 'dev', CADENCE_TRUST_PROXY: 'loopback', CADENCE_ALLOWED_HOSTS: 'cadence.home' });
    try {
      const rebound = { host: 'rebind.attacker.example:8787', 'x-forwarded-host': 'localhost:8787' };
      expect((await s.app.inject({ url: '/api/athlete', headers: rebound })).statusCode).toBe(403);
      const write = await s.app.inject({
        method: 'PATCH',
        url: '/api/athlete',
        payload: { name: 'Mallory' },
        headers: { ...rebound, origin: 'http://rebind.attacker.example:8787', 'sec-fetch-site': 'same-origin' },
      });
      expect(write.statusCode).toBe(403);
      // the proxy itself: Host as it forwards it (nginx: the upstream address, Caddy: the site), the name in X-Forwarded-Host
      for (const host of ['127.0.0.1:8787', 'cadence.home']) {
        const res = await s.app.inject({ url: '/api/athlete', headers: { host, 'x-forwarded-host': 'cadence.home' } });
        expect(res.statusCode, host).toBe(200);
      }
      // a forwarded name that is not allowed still counts
      const other = await s.app.inject({ url: '/api/athlete', headers: { host: '127.0.0.1:8787', 'x-forwarded-host': 'evil.example' } });
      expect(other.statusCode).toBe(403);
    } finally {
      await s.close();
    }
  });

  it('accepts extra host names from CADENCE_ALLOWED_HOSTS', async () => {
    const s = await server({ CADENCE_MODE: 'dev', CADENCE_ALLOWED_HOSTS: 'nas.local, .example.org' });
    try {
      for (const host of ['nas.local:8787', 'example.org', 'cadence.example.org', 'localhost:8787']) {
        expect((await s.app.inject({ url: '/api/athlete', headers: { host } })).statusCode, host).toBe(200);
      }
      expect((await s.app.inject({ url: '/api/athlete', headers: { host: 'badexample.org' } })).statusCode).toBe(403);
    } finally {
      await s.close();
    }
  });
});

describe('configuration', () => {
  const cfg = (env: Record<string, string>) => loadConfig({ CADENCE_DATA_DIR: '/tmp/cadence-x', ...env });

  it('keeps a server without a password on this machine unless HOST says otherwise', () => {
    expect(cfg({ CADENCE_MODE: 'server' }).host).toBe('127.0.0.1');
    expect(cfg({ CADENCE_MODE: 'server', CADENCE_PASSWORD: 'pw' }).host).toBe('0.0.0.0');
    expect(cfg({ CADENCE_MODE: 'server', HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
    expect(cfg({ CADENCE_MODE: 'desktop' }).host).toBe('127.0.0.1');
  });

  it('checks host names where nothing else protects the API', () => {
    expect(cfg({ CADENCE_MODE: 'desktop' }).allowedHosts).toEqual([]);
    expect(cfg({ CADENCE_MODE: 'dev' }).allowedHosts).toEqual([]);
    expect(cfg({ CADENCE_MODE: 'server' }).allowedHosts).toEqual([]); // no password, loopback
    expect(cfg({ CADENCE_MODE: 'server', HOST: '0.0.0.0' }).allowedHosts).toBeNull(); // Docker without password
    expect(cfg({ CADENCE_MODE: 'server', CADENCE_PASSWORD: 'pw' }).allowedHosts).toBeNull();
    expect(cfg({ CADENCE_MODE: 'server', CADENCE_PASSWORD: 'pw', CADENCE_ALLOWED_HOSTS: 'A.example' }).allowedHosts).toEqual(['a.example']);
    expect(cfg({ CADENCE_MODE: 'desktop', CADENCE_ALLOWED_HOSTS: '*' }).allowedHosts).toBeNull();
  });

  it('trusts a reverse proxy only when told so', () => {
    expect(cfg({}).trustProxy).toBe(false);
    expect(cfg({ CADENCE_TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(cfg({ CADENCE_TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(cfg({ CADENCE_TRUST_PROXY: '127.0.0.1, 172.16.0.0/12' }).trustProxy).toBe('127.0.0.1, 172.16.0.0/12');
    expect(() => cfg({ CADENCE_TRUST_PROXY: '1' })).toThrow(/address/);
  });

  it('allows local host names and IP addresses', () => {
    expect(hostAllowed('127.0.0.1:8787', [])).toBe(true);
    expect(hostAllowed('[::1]:8787', [])).toBe(true);
    expect(hostAllowed('localhost.', [])).toBe(true);
    expect(hostAllowed('evil.example', [])).toBe(false);
    expect(hostAllowed('127.0.0.1.evil.example', [])).toBe(false);
    expect(hostAllowed('[::1].evil.example', [])).toBe(false);
    expect(hostAllowed('', [])).toBe(true); // HTTP/1.0 without Host: no browser
  });

  it('counts IPv6 clients per /64 and IPv4 clients per address', () => {
    expect(clientKey('1.2.3.4')).toBe('1.2.3.4');
    expect(clientKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(clientKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
    expect(clientKey('fe80::1%en0')).toBe('fe80:0:0:0::/64');
    expect(clientKey(undefined)).toBe('');
  });
});
