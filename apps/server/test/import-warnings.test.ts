import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { openDb, type Db } from '../src/db/db';
import { executeJob } from '../src/import/run-job';
import { WarningCollector } from '../src/import/warnings';

const noop = { progress: () => {}, checkCancelled: () => {}, log: () => {} };
let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-warnings-'));
  db = openDb(path.join(dir, 'cadence.db'));
  migrateAll(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const record = (type: string, start: string, value = 10) =>
  `<Record type="${type}" sourceName="iPhone" unit="count" startDate="${start}" endDate="${start}" value="${value}"/>`;

function exportXml(body: string[]): string {
  const file = path.join(dir, 'export.xml');
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">\n<ExportDate value="2026-10-31 10:00:00 +0100"/>\n${body.join('\n')}\n</HealthData>\n`,
  );
  return file;
}

describe('import warnings', () => {
  it('counts repeated warnings and names every record type with unparseable dates', async () => {
    const file = exportXml([
      record('HKQuantityTypeIdentifierStepCount', '2026-10-30 08:00:00 +0100'),
      record('HKQuantityTypeIdentifierStepCount', 'yesterday'),
      record('HKQuantityTypeIdentifierStepCount', 'garbage'),
      record('HKQuantityTypeIdentifierStepCount', '??'),
      record('HKQuantityTypeIdentifierFlightsClimbed', 'nope'),
      '<Record sourceName="iPhone" startDate="2026-10-30 08:00:00 +0100" value="1"/>',
    ]);
    const stats = await executeJob(
      db,
      { id: 't', kind: 'import', athleteId: 1, sourcePath: file, options: {} },
      noop,
    );
    expect(stats.recordsInserted).toBe(1);
    expect(stats.warnings).toEqual([
      'Record with unparseable date skipped (HKQuantityTypeIdentifierStepCount) (×3)',
      'Record with unparseable date skipped (HKQuantityTypeIdentifierFlightsClimbed)',
      'Record without type attribute skipped',
    ]);
  });

  it('keeps at most 200 distinct warnings and shows the first ones while the import runs', () => {
    const live: string[] = [];
    const w = new WarningCollector(live);
    for (let i = 0; i < 300; i++) w.add(`Unreadable route ${i}.gpx`, 'route');
    for (let i = 0; i < 300; i++) w.add(`warning ${i}`);
    expect(live[0]).toBe('Unreadable route 0.gpx');
    expect(live).toHaveLength(200);
    const lines = w.finish();
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe('Unreadable route 0.gpx (×300)');
    expect(lines[199]).toBe('warning 198');
  });
});
