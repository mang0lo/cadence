import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkoutStreams } from '@cadence/shared';
import { migrateAll } from '../src/app';
import { updateSettings } from '../src/core/settings';
import { detectDuplicates } from '../src/derive/duplicates';
import { all, get, openDb, run, type Db } from '../src/db/db';
import { openFitSource } from '../src/import/fit/import';
import { parseFit } from '../src/import/fit/parse';
import { executeJob } from '../src/import/run-job';
import { gunzipJson } from '../src/lib/gzip';
import { buildFit } from './fit-fixture';

const noop = { progress: () => {}, checkCancelled: () => {}, log: () => {} };
const START = 1_780_000_000; // 2026-05-28
let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-fit-'));
  db = openDb(path.join(dir, 'cadence.db'));
  migrateAll(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const importPath = (p: string, options = {}) =>
  executeJob(db, { id: 't', kind: 'import', athleteId: 1, sourcePath: p, options }, noop);

function writeFit(name: string, opts: Parameters<typeof buildFit>[0]): string {
  const f = path.join(dir, 'fit', name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, buildFit(opts));
  return f;
}

describe('FIT parsing', () => {
  it('maps a COROS run to a workout, track and sensor samples', () => {
    const a = parseFit(buildFit({ start: START, pause: [600, 660], tzMin: 120 }));
    expect(a.sport).toBe('run');
    expect(a.activityType).toBe('HKWorkoutActivityTypeRunning');
    expect(a.startTs).toBe(START);
    expect(a.endTs).toBe(START + 1800);
    expect(a.durationS).toBe(1740);
    expect(a.tzMin).toBe(120);
    expect(a.manufacturer).toBe('COROS');
    expect(a.product).toBe('PACE 3');
    expect(a.extKey).toBe(`fit:123456:${START}`);
    expect(a.indoor).toBe(false);
    expect(a.events.filter((e) => e.type !== 'lap')).toEqual([
      { type: 'pause', ts: START + 600 },
      { type: 'resume', ts: START + 660 },
    ]);
    expect(a.track!.t.length).toBeGreaterThan(1700);
    expect(a.track!.lat[0]).toBeCloseTo(48.2, 5);
    // strides per minute → steps per minute
    expect(a.samples!.cadence![10]).toBe(170);
    expect(a.samples!.hr![0]).toBe(140);
    expect(a.stats.find((s) => s.type.endsWith('DistanceWalkingRunning'))?.sum).toBe(5223);
    expect(a.meta.HKElevationAscended).toBe('12 m');
  });

  it('marks treadmill runs as indoor and keeps the device distance', () => {
    const a = parseFit(buildFit({ start: START, gps: false, sport: 'training', subSport: 'treadmill' }));
    expect(a.sport).toBe('run');
    expect(a.indoor).toBe(true);
    expect(a.track).toBeNull();
    expect(a.samples!.dist![a.samples!.dist!.length - 1]).toBe(5400);
  });

  it('rejects files that are not FIT activities', () => {
    expect(() => parseFit(new Uint8Array([1, 2, 3, 4]))).toThrow(/Not a FIT file/);
  });
});

describe('FIT import', () => {
  it('imports a folder of FIT files idempotently and derives streams, splits and best efforts', async () => {
    writeFit('a.fit', { start: START });
    writeFit('b.fit', { start: START + 86_400, serial: 999, sport: 'cycling', cadence: 90 });
    const stats = await importPath(path.join(dir, 'fit'));
    expect(stats.workoutsInserted).toBe(2);
    expect(stats.routesParsed).toBe(2);

    const w = get<Record<string, unknown>>(db, "SELECT * FROM workouts WHERE sport = 'run'")!;
    expect(w).toMatchObject({ source_name: 'COROS PACE 3', has_route: 1, indoor: 0, tz_min: 60 });
    expect(w).toMatchObject({ name: '', name_locked: 0 }); // auto title ("Morning Run") at display time
    expect(w.distance_m as number).toBeCloseTo(5400, -1);
    expect(w.avg_hr as number).toBeGreaterThan(130);
    expect(w.avg_cadence as number).toBeCloseTo(170, 0);
    expect(w.elevation_gain_m).toBe(12);
    const streams = gunzipJson<WorkoutStreams>(
      get<{ data: Uint8Array }>(db, 'SELECT data FROM workout_streams WHERE workout_id = ?', [w.id])!.data,
    );
    expect(streams.hr!.length).toBe(streams.t.length);
    expect(streams.power![100]).toBe(250);
    const splits = all(db, "SELECT * FROM workout_splits WHERE workout_id = ? AND unit = 'km'", [w.id]);
    expect(splits).toHaveLength(6);
    const efforts = all<{ effort: string }>(db, 'SELECT effort FROM best_efforts WHERE workout_id = ?', [
      w.id,
    ]);
    expect(efforts.map((e) => e.effort)).toContain('5k');

    const ride = get<Record<string, unknown>>(db, "SELECT * FROM workouts WHERE sport = 'ride'")!;
    expect(ride.avg_cadence as number).toBeCloseTo(90, 0); // rpm, not doubled

    const again = await importPath(path.join(dir, 'fit'));
    expect(again.workoutsSeen).toBe(2);
    expect(again.workoutsInserted).toBe(0);
  });

  it('imports only the listed files of a folder and applies the sidecar name', async () => {
    const a = writeFit('a.fit', { start: START });
    writeFit('b.fit', { start: START + 86_400, serial: 999 });
    fs.writeFileSync(`${a}.json`, JSON.stringify({ name: 'Prater loop', device: 'COROS PACE 3' }));
    const stats = await importPath(path.join(dir, 'fit'), { files: [a] });
    expect(stats.workoutsInserted).toBe(1);
    expect(get(db, 'SELECT name, name_locked, device FROM workouts')).toEqual({
      name: 'Prater loop',
      name_locked: 1,
      device: 'COROS PACE 3',
    });
  });

  it('imports a zip of FIT files', async () => {
    const zipPath = path.join(dir, 'coros-export.zip');
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(buildFit({ start: START })), 'activities/1.fit');
    zip.addBuffer(Buffer.from(buildFit({ start: START + 7200, serial: 7 })), 'activities/2.fit');
    zip.end();
    await new Promise<void>((resolve) =>
      zip.outputStream.pipe(fs.createWriteStream(zipPath)).on('close', () => resolve()),
    );
    const stats = await importPath(zipPath);
    expect(stats.workoutsInserted).toBe(2);
  });

  it('keeps the copy of the source chosen in Settings → My watch', async () => {
    run(
      db,
      `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, distance_m,
         avg_hr, source_name) VALUES (1, 'apple', 'HKWorkoutActivityTypeRunning', 'run', ?, ?, 60, 1800, 5400, 140, 'COROS')`,
      [START + 2, START + 1795],
    );
    writeFit('a.fit', { start: START });
    await importPath(path.join(dir, 'fit'));
    const rows = () =>
      all<{ ext_key: string; duplicate_of: number | null }>(
        db,
        'SELECT ext_key, duplicate_of FROM workouts ORDER BY id',
      );
    // default watch: Apple → the Health copy stays, the FIT copy is the duplicate
    expect(rows()[0]!.duplicate_of).toBeNull();
    expect(rows()[1]!.duplicate_of).not.toBeNull();
    // My watch: COROS → the device's own file wins
    updateSettings(db, 1, { watch: 'coros' });
    detectDuplicates(db, 1, 'all');
    expect(rows()[0]!.duplicate_of).not.toBeNull();
    expect(rows()[1]).toMatchObject({ ext_key: expect.stringMatching(/^fit:/), duplicate_of: null });
    // per type override: workouts from Apple even with a COROS watch
    updateSettings(db, 1, { sources: { workouts: 'apple', heart: 'auto' } });
    detectDuplicates(db, 1, 'all');
    expect(rows()[0]!.duplicate_of).toBeNull();
  });

  it('leaves Apple Health exports to the Apple importer', async () => {
    fs.mkdirSync(path.join(dir, 'apple_health_export'));
    fs.writeFileSync(path.join(dir, 'apple_health_export', 'export.xml'), '<HealthData/>');
    expect(await openFitSource(dir)).toBeNull();
  });
});
