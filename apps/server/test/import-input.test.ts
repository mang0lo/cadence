import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { get, openDb, type Db } from '../src/db/db';
import { executeJob } from '../src/import/run-job';
import { ImportInputError } from '../src/import/source';
import { createHealthFixture } from './health-fixture';

const noop = { progress: () => {}, checkCancelled: () => {}, log: () => {} };
let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-input-'));
  db = openDb(path.join(dir, 'cadence.db'));
  migrateAll(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const CDA = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <component><structuredBody><component><section><entry><observation><value value="72" unit="count/min"/></observation></entry></section></component></structuredBody></component>
</ClinicalDocument>
`;

const importFile = (file: string) =>
  executeJob(db, { id: 't', kind: 'import', athleteId: 1, sourcePath: file, options: {} }, noop);

describe('import input', () => {
  it('refuses an XML file that is not an Apple Health export', async () => {
    const file = path.join(dir, 'export.xml');
    fs.writeFileSync(file, CDA);
    const err = await importFile(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportInputError);
    expect((err as Error).message).toMatch(/Not an Apple Health export\.xml \(root element <ClinicalDocument>\)/);
    expect(get(db, 'SELECT COUNT(*) AS n FROM health_items')).toEqual({ n: 0 });
  });

  it('refuses export_cda.xml without reading it', async () => {
    const file = path.join(dir, 'export_cda.xml');
    fs.writeFileSync(file, CDA);
    await expect(importFile(file)).rejects.toThrow(/clinical document export/);
  });

  it('rejects an upload of export_cda.xml', async () => {
    const fx = await createHealthFixture();
    try {
      const boundary = '----cadence-test-boundary';
      const res = await fx.app.inject({
        method: 'POST',
        url: '/api/import/upload',
        payload: Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="export_cda.xml"\r\nContent-Type: text/xml\r\n\r\n${CDA}\r\n--${boundary}--\r\n`,
        ),
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
      expect(res.statusCode).toBe(400);
      expect(get(fx.db, 'SELECT COUNT(*) AS n FROM import_jobs')).toEqual({ n: 0 });
    } finally {
      await fx.close();
    }
  });
});
