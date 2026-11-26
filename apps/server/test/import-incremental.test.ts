import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { all, get, openDb, type Db } from '../src/db/db';
import { runImport } from '../src/import/importer';
import { executeJob } from '../src/import/run-job';

const noop = { progress: () => {}, checkCancelled: () => {}, log: () => {} };
let dir: string;
const dbs: Db[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-incremental-'));
});

afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function freshDb(name: string): Db {
  const d = openDb(path.join(dir, name));
  migrateAll(d);
  dbs.push(d);
  return d;
}

const DAY0 = Date.UTC(2026, 0, 1) / 1000;
const appleDate = (ts: number) => new Date((ts + 3600) * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' +0100';

/**
 * An export of `days` days, each record type in time order (like Apple's export.xml): heart rate and steps every
 * ~29 minutes, body mass once a day (a sparse type: 64 rows span two months).
 */
function exportXml(name: string, days: number): string {
  const lines: string[] = [];
  const rec = (type: string, unit: string, ts: number, value: number) =>
    lines.push(
      `<Record type="${type}" sourceName="Watch" unit="${unit}" startDate="${appleDate(ts)}" endDate="${appleDate(ts + 60)}" value="${value}"/>`,
    );
  for (let i = 0; i < days * 50; i++) rec('HKQuantityTypeIdentifierHeartRate', 'count/min', DAY0 + i * 1728, 60 + (i % 40));
  for (let i = 0; i < days * 50; i++) rec('HKQuantityTypeIdentifierStepCount', 'count', DAY0 + i * 1728 + 7, 10 + (i % 7));
  for (let d = 0; d < days; d++) rec('HKQuantityTypeIdentifierBodyMass', 'kg', DAY0 + d * 86400 + 25200, 70 + (d % 5) / 10);
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">\n<ExportDate value="2026-06-01 10:00:00 +0100"/>\n${lines.join('\n')}\n</HealthData>\n`,
  );
  return file;
}

describe('re-import of a newer export', () => {
  it('marks only the new records as changed', async () => {
    const db = freshDb('a.db');
    await runImport({ db, athleteId: 1, path: exportXml('old.xml', 100) });
    const res = await runImport({ db, athleteId: 1, path: exportXml('new.xml', 103) });
    expect(res.stats.recordsInserted).toBe(3 * 50 * 2 + 3);
    const cut = DAY0 + 100 * 86400;
    const types = new Map(
      all<{ id: number; identifier: string }>(db, 'SELECT id, identifier FROM record_types').map((r) => [r.id, r.identifier]),
    );
    const since = [...res.scope.types].map(([id, ts]) => [types.get(id), ts - cut]);
    // each type from its first new record on: 0 s / 7 s / 7 h after the cut (not from the type's oldest rows)
    expect(since.sort()).toEqual([
      ['HKQuantityTypeIdentifierBodyMass', 25200],
      ['HKQuantityTypeIdentifierHeartRate', 0],
      ['HKQuantityTypeIdentifierStepCount', 7],
    ]);
    expect(res.scope.sinceDay('x')).toBe('2026-04-10');
  });

  it('derives the same daily metrics as an import of the newer export alone', async () => {
    const a = freshDb('a.db');
    const job = (d: Db, file: string) =>
      executeJob(d, { id: 't', kind: 'import', athleteId: 1, sourcePath: file, options: {} }, noop);
    await job(a, exportXml('old.xml', 100));
    await job(a, exportXml('new.xml', 103));
    const b = freshDb('b.db');
    await job(b, path.join(dir, 'new.xml'));
    const metrics = (d: Db) => all(d, 'SELECT metric, day, value, min, max, n FROM daily_metrics ORDER BY metric, day');
    expect(metrics(a)).toEqual(metrics(b));
    expect(metrics(a).length).toBeGreaterThan(300);
    const stats = (d: Db) =>
      all(d, 'SELECT t.identifier, count, first_ts, last_ts FROM record_type_stats s JOIN record_types t ON t.id = s.type_id ORDER BY 1');
    expect(stats(a)).toEqual(stats(b));
    expect(get(a, "SELECT COUNT(*) AS n FROM settings WHERE key IN ('core.pendingDerive', 'core.deriveClaim')")).toEqual({ n: 0 });
  });
});
