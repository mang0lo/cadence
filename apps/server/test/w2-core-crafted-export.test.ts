import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { get, openDb, type Db } from '../src/db/db';
import { executeJob } from '../src/import/run-job';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-w2-crafted-'));
  db = openDb(path.join(dir, 'cadence.db'));
  migrateAll(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** An export whose values are keys of every JavaScript object: they must stay plain text, not reach Object's members. */
const EXPORT = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="2026-05-02 10:00:00 +0200"/>
 <Me HKCharacteristicTypeIdentifierDateOfBirth="1985-06-15" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale" HKCharacteristicTypeIdentifierBloodType="HKBloodTypeconstructor" HKCharacteristicTypeIdentifierFitzpatrickSkinType="HKFitzpatrickSkinTypeNotSet"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="toString" creationDate="2026-05-01 09:10:00 +0200" startDate="2026-05-01 09:00:00 +0200" endDate="2026-05-01 09:10:00 +0200" value="100"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" creationDate="2026-05-01 09:10:00 +0200" startDate="2026-05-01 09:05:00 +0200" endDate="2026-05-01 09:05:00 +0200" value="72"/>
</HealthData>
`;

describe('an export with values named like object members', () => {
  it('imports them as they are', async () => {
    const file = path.join(dir, 'export.xml');
    fs.writeFileSync(file, EXPORT);
    const noop = { progress: () => {}, checkCancelled: () => {}, log: () => {} };
    const stats = await executeJob(db, { id: 't', kind: 'import', athleteId: 1, sourcePath: file, options: {} }, noop);
    expect(stats.recordsInserted).toBe(2);
    expect(get(db, 'SELECT blood_type, sex FROM athletes WHERE id = 1')).toEqual({ blood_type: 'constructor', sex: 'male' });
    expect(
      get(
        db,
        `SELECT r.value, t.unit FROM records r JOIN record_types t ON t.id = r.type_id
         WHERE t.identifier = 'HKQuantityTypeIdentifierStepCount'`,
      ),
    ).toEqual({ value: 100, unit: 'toString' });
  });
});
