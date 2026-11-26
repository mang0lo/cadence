import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb, type Db } from '../src/db/db';

describe('a write while another connection holds the database', () => {
  let dir: string;
  let db: Db;
  let app: FastifyInstance;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-busy-'));
    const config = loadConfig({ CADENCE_DATA_DIR: path.join(dir, 'data'), CADENCE_MODE: 'desktop', LOG_LEVEL: 'silent' });
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

  it('answers 503 busy (retryable) instead of a 500', async () => {
    const other = new DatabaseSync(path.join(dir, 'data', 'cadence.db'));
    db.exec('PRAGMA busy_timeout = 0'); // fail at once instead of after 15 s
    try {
      other.exec('BEGIN IMMEDIATE');
      const res = await app.inject({ method: 'PATCH', url: '/api/athlete', payload: { name: 'Busy' } });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('busy');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      other.exec('ROLLBACK');
      const ok = await app.inject({ method: 'PATCH', url: '/api/athlete', payload: { name: 'Free' } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().name).toBe('Free');
    } finally {
      if (other.isTransaction) other.exec('ROLLBACK');
      other.close();
      db.exec('PRAGMA busy_timeout = 15000');
    }
  });
});
