import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb, run, type Db } from '../src/db/db';

/**
 * In-memory Cadence server with the health feature, plus small helpers to seed records / daily metrics.
 * Sources: 1 = iPhone, 2 = Apple Watch, 3 = Withings.
 */
export const SRC = { phone: 1, watch: 2, scale: 3 };

export const ts = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

export interface HealthFixture {
  db: Db;
  app: FastifyInstance;
  /** record type ids by short name */
  T: Record<string, number>;
  addType(id: number, identifier: string, kind: string, unit: string | null, aggregation: string): number;
  rec(
    typeId: number,
    startIso: string,
    endIso: string,
    o?: { tz?: number; value?: number | null; text?: string | null; source?: number; meta?: string | null },
  ): void;
  daily(metric: string, day: string, value: number, extra?: { min?: number; max?: number; n?: number }): void;
  refreshStats(): void;
  getJson<T>(url: string): Promise<T>;
  close(): Promise<void>;
}

export async function createHealthFixture(): Promise<HealthFixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-health-'));
  const config = loadConfig({ CADENCE_DATA_DIR: dir, CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
  const db = openDb(':memory:');
  migrateAll(db);
  const app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();
  run(db, "INSERT INTO sources (id, name) VALUES (1, 'iPhone von Hannes'), (2, 'Apple Watch von Hannes'), (3, 'Withings')");

  let hashSeq = 1;
  const T: Record<string, number> = {};
  const fx: HealthFixture = {
    db,
    app,
    T,
    addType(id, identifier, kind, unit, aggregation) {
      run(db, 'INSERT INTO record_types (id, identifier, kind, unit, aggregation) VALUES (?, ?, ?, ?, ?)', [id, identifier, kind, unit, aggregation]);
      return id;
    },
    rec(typeId, startIso, endIso, o = {}) {
      run(
        db,
        `INSERT INTO records (athlete_id, type_id, start_ts, hash, end_ts, tz_min, value, text, source_id, meta)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [typeId, ts(startIso), hashSeq++, ts(endIso), o.tz ?? 60, o.value ?? null, o.text ?? null, o.source ?? SRC.watch, o.meta ?? null],
      );
    },
    daily(metric, day, value, extra = {}) {
      run(db, 'INSERT OR REPLACE INTO daily_metrics (athlete_id, metric, day, value, min, max, n) VALUES (1, ?, ?, ?, ?, ?, ?)', [
        metric,
        day,
        value,
        extra.min ?? null,
        extra.max ?? null,
        extra.n ?? 1,
      ]);
    },
    refreshStats() {
      run(db, 'DELETE FROM record_type_stats');
      run(
        db,
        `INSERT INTO record_type_stats (athlete_id, type_id, count, first_ts, last_ts)
         SELECT athlete_id, type_id, COUNT(*), MIN(start_ts), MAX(start_ts) FROM records GROUP BY athlete_id, type_id`,
      );
    },
    async getJson<T>(url: string): Promise<T> {
      const res = await app.inject({ url });
      expect(res.statusCode, `${url}: ${res.body.slice(0, 300)}`).toBe(200);
      return res.json<T>();
    },
    async close() {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return fx;
}
