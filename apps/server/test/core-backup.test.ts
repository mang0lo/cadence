import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { WorkerOptions } from 'node:worker_threads';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { openDb, type Db } from '../src/db/db';

// counts the snapshot workers (eval workers) the backup route starts
const counter = vi.hoisted(() => ({ snapshots: 0 }));
vi.mock('node:worker_threads', async (importOriginal) => {
  const m = await importOriginal<typeof import('node:worker_threads')>();
  class CountingWorker extends m.Worker {
    constructor(file: string | URL, opts?: WorkerOptions) {
      super(file, opts);
      if (opts?.eval) counter.snapshots++;
    }
  }
  return { ...m, default: { ...m, Worker: CountingWorker }, Worker: CountingWorker };
});

let dir: string;
let config: Config;
let db: Db;
let app: FastifyInstance;
const leftovers = () => fs.readdirSync(config.dataDir).filter((f) => f.startsWith('backup-'));
const settle = async () => {
  for (let i = 0; i < 100 && leftovers().length; i++) await new Promise((r) => setTimeout(r, 20));
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-core-backup-'));
  config = loadConfig({ CADENCE_DATA_DIR: path.join(dir, 'data'), CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
  db = openDb(config.dbPath);
  migrateAll(db);
  // large enough that a download does not fit into the socket buffers at once
  db.exec(`CREATE TABLE ballast (b BLOB);
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 24)
    INSERT INTO ballast SELECT randomblob(1048576) FROM n`);
  app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('backup downloads', () => {
  it('makes the snapshot in a worker, one for parallel requests, and removes it after the last download', async () => {
    const before = counter.snapshots;
    const [a, b] = await Promise.all([app.inject({ url: '/api/backup' }), app.inject({ url: '/api/backup' })]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.rawPayload.length).toBeGreaterThan(24 * 1048576);
    expect(Buffer.compare(a.rawPayload, b.rawPayload)).toBe(0);
    expect(counter.snapshots - before).toBe(1);
    await settle();
    expect(leftovers()).toEqual([]);
    // the next download is a new snapshot
    expect((await app.inject({ url: '/api/backup' })).statusCode).toBe(200);
    expect(counter.snapshots - before).toBe(2);
    await settle();
    expect(leftovers()).toEqual([]);
  });

  it('asks a later download to wait while an older one still streams, then works again', async () => {
    const port = (app.server.address() as AddressInfo).port;
    // a download that does not read: the snapshot stays in use
    const slow = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/backup' }, resolve).on('error', reject);
    });
    slow.pause();
    expect(slow.statusCode).toBe(200);
    // fresh: a parallel request shares it
    expect((await app.inject({ url: '/api/backup' })).statusCode).toBe(200);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
    try {
      const busy = await app.inject({ url: '/api/backup' });
      expect(busy.statusCode).toBe(409);
      expect(busy.json().error.code).toBe('busy');
    } finally {
      clock.mockRestore();
    }
    slow.destroy();
    await settle();
    expect(leftovers()).toEqual([]);
    expect((await app.inject({ url: '/api/backup' })).statusCode).toBe(200);
  });
});
