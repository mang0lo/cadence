import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeUnit } from '@cadence/shared';
import { migrateAll } from '../src/app';
import { all, get, openDb, run, type Db } from '../src/db/db';
import { fnv1a } from '../src/lib/hash';
import { executeJob } from '../src/import/run-job';
import { pendingScope } from '../src/import/scope';
import { convertLateVolumeUnits } from '../src/import/unit-fix';

const noop = { progress: () => {}, checkCancelled: () => {}, log: () => {} };
const WATER = 'HKQuantityTypeIdentifierDietaryWater';
let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-units-'));
  db = openDb(path.join(dir, 'cadence.db'));
  migrateAll(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Ten glasses of water (one a day at noon), in `unit`. */
function waterExport(name: string, unit: string, perGlass: number): string {
  const lines: string[] = [];
  for (let d = 1; d <= 10; d++) {
    const date = `2026-05-${String(d).padStart(2, '0')} 12:00:00 +0100`;
    lines.push(
      `<Record type="${WATER}" sourceName="WaterMinder" unit="${unit}" startDate="${date}" endDate="${date}" value="${perGlass}"/>`,
    );
  }
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_GB">\n${lines.join('\n')}\n</HealthData>\n`,
  );
  return file;
}

const importFile = (file: string) =>
  executeJob(db, { id: 't', kind: 'import', athleteId: 1, sourcePath: file, options: {} }, noop);

const water = () =>
  all<{ value: number }>(
    db,
    'SELECT value FROM records r JOIN record_types t ON t.id = r.type_id WHERE t.identifier = ? ORDER BY start_ts',
    [WATER],
  ).map((r) => r.value);
const unit = () => get<{ unit: string }>(db, 'SELECT unit FROM record_types WHERE identifier = ?', [WATER])?.unit;

describe('volume units', () => {
  it('converts imperial and US volumes to litres', () => {
    expect(normalizeUnit(1, 'fl_oz_imp')).toEqual({ value: 0.0284130625, unit: 'L' });
    expect(normalizeUnit(2, 'cup_imp').value).toBeCloseTo(0.56826125);
    expect(normalizeUnit(1, 'pt_imp').value).toBeCloseTo(0.56826125);
    expect(normalizeUnit(1, 'pt_us').value).toBeCloseTo(0.473176473);
    expect(normalizeUnit(5, 'dL').value).toBeCloseTo(0.5);
    // other units with an L stay as they are
    expect(normalizeUnit(3.1, 'L')).toEqual({ value: 3.1, unit: 'L' });
    expect(normalizeUnit(90, 'mg/dL')).toEqual({ value: 90, unit: 'mg/dL' });
  });

  it('stores water exported in imperial fl oz as litres, and dedupes it against millilitres', async () => {
    const s = await importFile(waterExport('imp.xml', 'fl_oz_imp', 17.5975));
    expect(s.warnings).toEqual([]);
    expect(unit()).toBe('L');
    for (const v of water()) expect(v).toBeCloseTo(0.5, 4);
    const daily = get<{ value: number }>(db, 'SELECT value FROM daily_metrics WHERE metric = ? LIMIT 1', [WATER])!;
    expect(daily.value).toBeCloseTo(0.5, 4);
    // the same glasses exported in mL after a change of the unit preference: nothing new
    const again = await importFile(waterExport('ml.xml', 'mL', 500));
    expect(again.recordsInserted).toBe(0);
    expect(water()).toHaveLength(10);
  });

  it('converts what an older version stored in imperial fl oz', async () => {
    // as stored up to 1.0: unit fl_oz_imp, raw values, hash of the raw value
    run(db, "INSERT INTO record_types (id, identifier, kind, unit, aggregation) VALUES (5, ?, 'quantity', 'fl_oz_imp', 'sum')", [WATER]);
    run(db, "INSERT INTO sources (id, name) VALUES (3, 'WaterMinder')");
    const day = Date.UTC(2026, 4, 1, 11) / 1000;
    for (let d = 0; d < 10; d++) {
      const ts = day + d * 86400;
      run(
        db,
        'INSERT INTO records (athlete_id, type_id, start_ts, hash, end_ts, tz_min, value, source_id) VALUES (1, 5, ?, ?, ?, 60, ?, 3)',
        [ts, fnv1a(`${ts}|WaterMinder|${(17.5975).toPrecision(5)}|`), ts, 17.5975],
      );
    }
    convertLateVolumeUnits(db);
    expect(unit()).toBe('L');
    for (const v of water()) expect(v).toBeCloseTo(0.5, 4);
    // the next derive rebuilds the daily metrics of the type
    expect(pendingScope(db, 1).toJSON()).toEqual({ types: { 5: day }, minTs: day });
    // a re-import of the same export (now converted on import) adds nothing
    const again = await importFile(waterExport('imp.xml', 'fl_oz_imp', 17.5975));
    expect(again.recordsInserted).toBe(0);
    expect(get(db, 'SELECT COUNT(*) AS n FROM daily_metrics WHERE metric = ?', [WATER])).toEqual({ n: 10 });
    expect(get<{ v: number }>(db, 'SELECT MAX(value) AS v FROM daily_metrics WHERE metric = ?', [WATER])!.v).toBeCloseTo(0.5, 4);
  });

  it('only relabels a type whose history mixes units', () => {
    run(db, "INSERT INTO record_types (id, identifier, kind, unit, aggregation) VALUES (5, ?, 'quantity', 'fl_oz_imp', 'sum')", [WATER]);
    run(db, "INSERT INTO sources (id, name) VALUES (3, 'WaterMinder')");
    run(db, 'INSERT INTO records (athlete_id, type_id, start_ts, hash, end_ts, tz_min, value, source_id) VALUES (1, 5, 100, 1, 100, 0, 0.5, 3)');
    run(
      db,
      "INSERT INTO import_jobs (id, athlete_id, kind, status, progress, stats) VALUES ('j', 1, 'import', 'done', 1, ?)",
      [JSON.stringify({ warnings: [`${WATER}: mixed units (fl_oz_imp and mL); values kept as exported`] })],
    );
    convertLateVolumeUnits(db);
    expect(unit()).toBe('L');
    expect(water()).toEqual([0.5]);
  });
});
