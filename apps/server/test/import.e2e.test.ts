import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ImportStats, WorkoutStreams } from '@cadence/shared';
import { generateSample } from '../scripts/sample/generate';
import { migrateAll } from '../src/app';
import { all, get, openDb, type Db } from '../src/db/db';
import { CancelledError } from '../src/derive/context';
import { executeJob } from '../src/import/run-job';
import { openExportSource } from '../src/import/source';
import { decodePolyline, haversine } from '../src/lib/geo';
import { gunzipJson } from '../src/lib/gzip';
import { tzOffsetMinutes } from '../src/lib/tz';

const noop = { progress: () => {}, checkCancelled: () => {}, log: () => {} };
let dir: string;
let zip: string;
let db: Db;
let stats: ImportStats;

async function importInto(file: string, target: Db, hooks = noop): Promise<ImportStats> {
  return executeJob(
    target,
    { id: 'test', kind: 'import', athleteId: 1, sourcePath: file, options: {} },
    hooks,
  );
}

function freshDb(name: string): Db {
  const d = openDb(path.join(dir, name));
  migrateAll(d);
  return d;
}

const n = (sql: string, params: unknown[] = []) => get<{ n: number }>(db, sql, params)!.n;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-e2e-'));
  zip = path.join(dir, 'export.zip');
  await generateSample({ out: zip, size: 'small', seed: 42, endDate: '2026-10-31' });
  db = freshDb('test.db');
  stats = await importInto(zip, db);
}, 120_000);

afterAll(() => {
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('end-to-end import of the small sample', () => {
  it('imports every element type', () => {
    expect(stats.locale).toBe('de_AT');
    expect(stats.exportDate).toMatch(/^2026-10-31 /);
    expect(stats.recordsInserted).toBeGreaterThan(80_000);
    expect(stats.recordsSeen - stats.recordsInserted).toBeLessThan(50); // correlation children are listed twice
    expect(stats.workoutsInserted).toBeGreaterThan(35);
    expect(stats.routesParsed).toBeGreaterThan(25);
    expect(stats.ecgReadings).toBe(3);
    expect(stats.activitySummaries).toBe(70);
    expect(stats.correlations).toBeGreaterThanOrEqual(2);
    expect(stats.otherItems).toBe(2); // Me + Audiogram
    expect(stats.bytesProcessed).toBe(stats.bytesTotal);
    expect(stats.warnings).toEqual([]);
    expect(n('SELECT COUNT(*) AS n FROM records')).toBe(stats.recordsInserted);
    expect(n("SELECT COUNT(*) AS n FROM health_items WHERE kind = 'Audiogram'")).toBe(1);
  });

  it('maps <Me> to the athlete', () => {
    expect(get(db, 'SELECT birth_date, sex, blood_type, skin_type FROM athletes WHERE id = 1')).toEqual({
      birth_date: '1988-04-12',
      sex: 'male',
      blood_type: 'A+',
      skin_type: 'III',
    });
  });

  it('normalises units and category values', () => {
    const unit = (id: string) =>
      get<{ unit: string | null }>(db, 'SELECT unit FROM record_types WHERE identifier = ?', [id])?.unit;
    expect(unit('HKQuantityTypeIdentifierDistanceWalkingRunning')).toBe('m');
    expect(unit('HKQuantityTypeIdentifierRunningSpeed')).toBe('m/s');
    expect(unit('HKQuantityTypeIdentifierBodyMass')).toBe('kg');
    expect(unit('HKQuantityTypeIdentifierHeight')).toBe('m');
    expect(unit('HKCategoryTypeIdentifierSleepAnalysis')).toBeNull();
    const height = get<{ value: number }>(
      db,
      `SELECT value FROM records r JOIN record_types t ON t.id = r.type_id WHERE t.identifier = 'HKQuantityTypeIdentifierHeight'`,
    )!;
    expect(height.value).toBeCloseTo(1.82);
    const sleep = all<{ text: string }>(
      db,
      `SELECT DISTINCT text FROM records r JOIN record_types t ON t.id = r.type_id WHERE t.identifier = 'HKCategoryTypeIdentifierSleepAnalysis' ORDER BY text`,
    ).map((r) => r.text);
    expect(sleep).toEqual(['AsleepCore', 'AsleepDeep', 'AsleepREM', 'Awake', 'InBed']);
    // HRV beat lists end up in meta
    const hrv = get<{ meta: string }>(
      db,
      `SELECT meta FROM records r JOIN record_types t ON t.id = r.type_id WHERE t.identifier = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN' LIMIT 1`,
    )!;
    expect(JSON.parse(hrv.meta).beats.length).toBeGreaterThan(30);
    // devices deduplicated despite changing object pointers
    expect(n('SELECT COUNT(*) AS n FROM devices')).toBeLessThan(6);
  });

  it('derives GPS workouts: streams, splits, polyline, efforts', () => {
    const runs = all<{
      id: number;
      distance_m: number;
      moving_s: number;
      start_ts: number;
      end_ts: number;
      start_lat: number;
      start_lon: number;
      polyline: string;
    }>(
      db,
      "SELECT * FROM workouts WHERE sport = 'run' AND has_route = 1 AND duplicate_of IS NULL ORDER BY start_ts",
    );
    expect(runs.length).toBeGreaterThan(10);
    for (const w of runs) {
      const s = gunzipJson<WorkoutStreams>(
        get<{ data: Uint8Array }>(db, 'SELECT data FROM workout_streams WHERE workout_id = ?', [w.id])!.data,
      );
      const len = s.t.length;
      for (const k of ['lat', 'lon', 'ele', 'dist', 'speed', 'hr', 'cadence', 'power', 'moving'] as const)
        expect(s[k]?.length).toBe(len);
      expect(s.dist![len - 1]).toBeCloseTo(w.distance_m, -1);
      expect(s.hr!.filter((x) => x !== null).length).toBeGreaterThan(len * 0.9);
      expect(s.lat!.every((x) => (x > 48.1 && x < 48.4) || (x > 40.7 && x < 40.9))).toBe(true);
      expect(w.moving_s).toBeLessThanOrEqual(w.end_ts - w.start_ts);
      const pts = decodePolyline(w.polyline);
      expect(pts.length).toBeGreaterThan(5);
      expect(pts.length).toBeLessThan(len);
      expect(haversine(pts[0]![0], pts[0]![1], w.start_lat, w.start_lon)).toBeLessThan(2);
      const splits = all<{ distance_m: number }>(
        db,
        "SELECT distance_m FROM workout_splits WHERE workout_id = ? AND unit = 'km' ORDER BY idx",
        [w.id],
      );
      expect(splits.length).toBe(Math.ceil((w.distance_m - 10) / 1000));
      expect(splits.reduce((a, x) => a + x.distance_m, 0)).toBeCloseTo(w.distance_m, -1);
    }
    for (const e of all<{ distance_m: number; elapsed_s: number }>(
      db,
      "SELECT distance_m, elapsed_s FROM best_efforts WHERE sport = 'run'",
    ))
      expect(e.distance_m / e.elapsed_s).toBeLessThan(10.5);
    const race = get<{ elapsed_s: number }>(
      db,
      "SELECT elapsed_s FROM best_efforts WHERE sport = 'run' AND effort = '5k' ORDER BY elapsed_s LIMIT 1",
    )!;
    expect(race.elapsed_s).toBeGreaterThan(900);
    expect(race.elapsed_s).toBeLessThan(2400);
  });

  it('handles the special workouts', () => {
    const abroad = get<{ tz_min: number; start_ts: number }>(
      db,
      "SELECT tz_min, start_ts FROM workouts WHERE timezone = 'America/New_York'",
    )!;
    expect(abroad.tz_min).toBe(tzOffsetMinutes('America/New_York', abroad.start_ts));
    expect(new Date((abroad.start_ts + abroad.tz_min * 60) * 1000).getUTCHours()).toBe(7);

    const legacy = get<{ distance_m: number; energy_kcal: number; has_route: number; stats: string }>(
      db,
      "SELECT distance_m, energy_kcal, has_route, stats FROM workouts WHERE source_name = 'Runkeeper'",
    )!;
    expect(legacy.distance_m).toBeGreaterThan(5000);
    expect(legacy.energy_kcal).toBeGreaterThan(200);
    expect(JSON.parse(legacy.stats).map((s: { type: string }) => s.type)).toContain(
      'HKQuantityTypeIdentifierDistanceWalkingRunning',
    );

    const copy = get<{ id: number; duplicate_of: number; start_ts: number }>(
      db,
      "SELECT id, duplicate_of, start_ts FROM workouts WHERE source_name = 'Strava'",
    )!;
    const original = get<{ id: number; source_name: string; start_ts: number; has_route: number }>(
      db,
      'SELECT * FROM workouts WHERE id = ?',
      [copy.duplicate_of],
    )!;
    expect(original.source_name).toMatch(/Apple Watch/);
    expect(original.has_route).toBe(1);
    expect(Math.abs(original.start_ts - copy.start_ts)).toBeLessThan(10);

    const multi = get<{ id: number; distance_m: number }>(
      db,
      "SELECT id, distance_m FROM workouts WHERE sport = 'multisport'",
    )!;
    const legs = all<{ sport: string }>(
      db,
      'SELECT sport FROM workout_activities WHERE workout_id = ? ORDER BY idx',
      [multi.id],
    ).map((r) => r.sport);
    expect(legs).toEqual(['swim', 'transition', 'ride', 'transition', 'run']);
    expect(multi.distance_m).toBeGreaterThan(26000);

    const treadmill = all<{ id: number; distance_m: number }>(
      db,
      "SELECT id, distance_m FROM workouts WHERE sport = 'run' AND indoor = 1",
    );
    expect(treadmill.length).toBeGreaterThan(0);
    for (const t of treadmill) {
      const s = gunzipJson<WorkoutStreams>(
        get<{ data: Uint8Array }>(db, 'SELECT data FROM workout_streams WHERE workout_id = ?', [t.id])!.data,
      );
      expect(s.lat).toBeUndefined();
      expect(s.dist![s.dist!.length - 1]).toBeCloseTo(t.distance_m, -1);
      expect(s.t[1]! - s.t[0]!).toBe(5);
    }

    const swim = get<{ id: number; distance_m: number; lap_length_m: number }>(
      db,
      "SELECT id, distance_m, lap_length_m FROM workouts WHERE sport = 'swim' LIMIT 1",
    )!;
    expect(swim.lap_length_m).toBe(25);
    expect(swim.distance_m % 25).toBe(0);
    expect(
      n("SELECT COUNT(*) AS n FROM workout_events WHERE workout_id = ? AND type = 'lap'", [swim.id]),
    ).toBe(swim.distance_m / 25);

    // every workout gets an effort; HR zones sum up to the time with heart rate
    expect(n('SELECT COUNT(*) AS n FROM workouts WHERE effort IS NULL')).toBe(0);
    for (const w of all<{ hr_zones: string; end_ts: number; start_ts: number }>(
      db,
      'SELECT hr_zones, start_ts, end_ts FROM workouts WHERE hr_zones IS NOT NULL',
    )) {
      const z = JSON.parse(w.hr_zones) as number[];
      expect(z.length).toBe(5);
      expect(z.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(w.end_ts - w.start_ts + 60);
    }
  });

  it('deduplicates cumulative metrics across sources and attributes sleep to the wake-up day', () => {
    const days = all<{ day: string; value: number }>(
      db,
      "SELECT day, value FROM daily_metrics WHERE metric = 'HKQuantityTypeIdentifierStepCount' ORDER BY day LIMIT 20 OFFSET 5",
    );
    for (const d of days) {
      const per = all<{ s: number }>(
        db,
        `SELECT SUM(value) AS s FROM records r JOIN record_types t ON t.id = r.type_id
         WHERE t.identifier = 'HKQuantityTypeIdentifierStepCount' AND date(r.start_ts + r.tz_min * 60, 'unixepoch') = ? GROUP BY r.source_id`,
        [d.day],
      ).map((r) => r.s);
      expect(d.value).toBeGreaterThanOrEqual(Math.max(...per) - 1e-6);
      expect(d.value).toBeLessThan(per.reduce((a, b) => a + b, 0));
    }
    const inBed = all<{ value: number }>(
      db,
      "SELECT value FROM daily_metrics WHERE metric = 'HKCategoryTypeIdentifierSleepAnalysis:InBed'",
    );
    expect(inBed.length).toBeGreaterThan(60);
    for (const r of inBed) {
      expect(r.value).toBeGreaterThan(360);
      expect(r.value).toBeLessThan(660);
    }
    // per-type stats are consistent with the records table
    for (const s of all<{ type_id: number; count: number }>(
      db,
      'SELECT type_id, count FROM record_type_stats',
    ))
      expect(n('SELECT COUNT(*) AS n FROM records WHERE type_id = ?', [s.type_id])).toBe(s.count);
    // workouts per day/sport (duplicates excluded)
    expect(n('SELECT SUM(count) AS n FROM daily_activity')).toBe(
      n('SELECT COUNT(*) AS n FROM workouts WHERE hidden = 0 AND duplicate_of IS NULL'),
    );
  });

  it('is idempotent when the same export is imported again', async () => {
    const tables = [
      'records',
      'workouts',
      'workout_routes',
      'workout_streams',
      'workout_splits',
      'best_efforts',
      'daily_metrics',
      'ecg_readings',
      'correlations',
      'health_items',
      'activity_summaries',
      'devices',
      'sources',
    ];
    const before = Object.fromEntries(tables.map((t) => [t, n(`SELECT COUNT(*) AS n FROM ${t}`)]));
    const again = await importInto(zip, db);
    expect(again.recordsSeen).toBe(stats.recordsSeen);
    expect(again.recordsInserted).toBe(0);
    expect(again.workoutsInserted).toBe(0);
    expect(again.routesParsed).toBe(0);
    expect(again.ecgReadings).toBe(0);
    expect(again.correlations).toBe(0);
    expect(again.otherItems).toBe(0);
    expect(again.activitySummaries).toBe(0);
    expect(Object.fromEntries(tables.map((t) => [t, n(`SELECT COUNT(*) AS n FROM ${t}`)]))).toEqual(before);
  });

  it('imports an unzipped folder (Export.xml in any case) with the same result', async () => {
    const root = path.join(dir, 'unzipped', 'apple_health_export');
    const src = await openExportSource(zip);
    const files = [
      'export.xml',
      ...src.list('workout-routes', '.gpx').map((f) => f.path),
      ...src.list('electrocardiograms', '.csv').map((f) => f.path),
    ];
    for (const f of files) {
      const target = path.join(root, f === 'export.xml' ? 'Export.xml' : f);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, await src.read(f));
    }
    src.close();
    const db2 = freshDb('folder.db');
    const s2 = await importInto(path.join(dir, 'unzipped'), db2);
    expect(s2.recordsInserted).toBe(stats.recordsInserted);
    expect(s2.workoutsInserted).toBe(stats.workoutsInserted);
    expect(s2.routesParsed).toBe(stats.routesParsed);
    expect(s2.ecgReadings).toBe(3);
    db2.close();
  });

  it('stops between batches when cancelled', async () => {
    const db3 = freshDb('cancel.db');
    let calls = 0;
    await expect(
      importInto(zip, db3, {
        ...noop,
        checkCancelled: () => {
          if (++calls > 1) throw new CancelledError();
        },
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    const partial = get<{ n: number }>(db3, 'SELECT COUNT(*) AS n FROM records')!.n;
    expect(partial).toBeLessThan(stats.recordsInserted);
    expect(db3.isTransaction).toBe(false);
    // finishing the import afterwards yields the complete data set
    await importInto(zip, db3);
    expect(get<{ n: number }>(db3, 'SELECT COUNT(*) AS n FROM records')!.n).toBe(stats.recordsInserted);
    db3.close();
  });
});
