import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';
import type { ImportStats } from '@cadence/shared';
import { prepare, tx, type Db } from '../../db/db';
import { dayString } from '../../lib/time';
import { tzOffsetMinutes } from '../../lib/tz';
import type { ImportResult, RunImportOptions } from '../importer';
import { encodeSamples } from '../samples';
import { ImportInputError } from '../source';
import { encodeTrack } from '../track';
import { emptyStats } from '../writer';
import { FitError, parseFit, type FitActivity } from './parse';

/**
 * FIT activity import: one `.fit` file, a folder of them (recursively), or a zip of them (Garmin / COROS bulk
 * exports). Every file becomes a workout with its GPS track (workout_routes, linked_by 'fit') and the device's
 * sensor samples (workout_samples); derive then builds streams, splits and best efforts as for Apple workouts.
 *
 * An optional sidecar `<file>.json` (`{ name?, device?, notes? }`, written by the device sync connectors) names
 * the workout and its device.
 */
export interface FitFile {
  /** Display / reference path (relative inside a zip). */
  path: string;
  read(): Promise<Buffer>;
  sidecar(): Promise<FitSidecar | null>;
}

export interface FitSidecar {
  name?: string;
  device?: string;
  notes?: string;
}

export interface FitSource {
  name: string;
  files: FitFile[];
  close(): void;
}

const isFit = (p: string) => /\.fit$/i.test(p);

function walkFit(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkFit(abs, depth + 1));
    else if (ent.isFile() && isFit(ent.name)) out.push(abs);
  }
  return out.sort();
}

function hasExportXml(dir: string, depth = 0): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  if (names.some((n) => n.toLowerCase() === 'export.xml')) return true;
  if (depth >= 2) return false;
  return names.some(
    (n) =>
      !n.startsWith('.') &&
      fs.statSync(path.join(dir, n), { throwIfNoEntry: false })?.isDirectory() &&
      hasExportXml(path.join(dir, n), depth + 1),
  );
}

const readSidecar = async (file: string): Promise<FitSidecar | null> => {
  try {
    return JSON.parse(await fs.promises.readFile(`${file}.json`, 'utf8')) as FitSidecar;
  } catch {
    return null;
  }
};

const diskFile = (abs: string): FitFile => ({
  path: abs,
  read: () => fs.promises.readFile(abs),
  sidecar: () => readSidecar(abs),
});

/**
 * Open `input` as a FIT source, or return null when it is an Apple Health export (or anything else) instead.
 * `only` restricts a folder to these files (absolute paths), e.g. what a sync just downloaded.
 */
export async function openFitSource(input: string, only?: string[]): Promise<FitSource | null> {
  const st = fs.statSync(input, { throwIfNoEntry: false });
  if (!st) return null;
  if (st.isFile() && isFit(input))
    return { name: path.basename(input), files: [diskFile(input)], close() {} };
  if (st.isDirectory()) {
    if (only) {
      const root = path.resolve(input) + path.sep;
      const files = only.filter((f) => path.resolve(f).startsWith(root) && fs.existsSync(f));
      return { name: path.basename(input), files: files.map(diskFile), close() {} };
    }
    if (hasExportXml(input)) return null;
    const files = walkFit(input);
    return files.length ? { name: path.basename(input), files: files.map(diskFile), close() {} } : null;
  }
  if (!st.isFile() || !/\.zip$/i.test(input)) return null;
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(input, { lazyEntries: true, autoClose: false, strictFileNames: false });
  } catch {
    return null;
  }
  const entries: yauzl.Entry[] = [];
  let apple = false;
  try {
    for await (const e of zip.eachEntry()) {
      const base = path.posix.basename(e.fileName).toLowerCase();
      if (base === 'export.xml') apple = true;
      else if (!e.fileName.endsWith('/') && isFit(e.fileName)) entries.push(e);
    }
  } catch {
    zip.close();
    return null;
  }
  if (apple || !entries.length) {
    zip.close();
    return null;
  }
  const readEntry = async (e: yauzl.Entry) => {
    const s = await zip.openReadStreamPromise(e);
    const chunks: Buffer[] = [];
    for await (const c of s) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  };
  return {
    name: path.basename(input),
    files: entries
      .sort((a, b) => a.fileName.localeCompare(b.fileName))
      .map((e) => ({ path: e.fileName, read: () => readEntry(e), sidecar: async () => null })),
    close: () => zip.close(),
  };
}

const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Import every file of a FIT source (see openFitSource). Same result shape as the Apple Health import. */
export async function runFitImport(o: RunImportOptions & { source: FitSource }): Promise<ImportResult> {
  const t0 = Date.now();
  const stats: ImportStats = emptyStats();
  const check = o.checkCancelled ?? (() => {});
  const src = o.source;
  const { db, athleteId } = o;
  const warnCounts = new Map<string, number>();
  const warn = (msg: string, key = msg) => {
    const n = (warnCounts.get(key) ?? 0) + 1;
    warnCounts.set(key, n);
    if (n === 1 && stats.warnings.length < 200) stats.warnings.push(msg);
  };
  if (!src.files.length) throw new ImportInputError('No FIT files to import');
  stats.bytesTotal = src.files.length;

  const ins = prepare(
    db,
    `INSERT OR IGNORE INTO workouts (
       athlete_id, ext_key, activity_type, sport, name, notes, name_locked, start_ts, end_ts, tz_min, timezone,
       duration_s, distance_m, energy_kcal, avg_hr, min_hr, max_hr, avg_power, max_power, avg_cadence, swim_strokes,
       lap_length_m, indoor, source_name, source_version, device, meta, stats)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insEvent = prepare(
    db,
    'INSERT OR IGNORE INTO workout_events (workout_id, idx, type, ts, duration_s, meta) VALUES (?, ?, ?, ?, ?, NULL)',
  );
  const insRoute = prepare(
    db,
    `INSERT OR REPLACE INTO workout_routes (workout_id, file, point_count, start_ts, end_ts, linked_by, data)
     VALUES (?, ?, ?, ?, ?, 'fit', ?)`,
  );
  const insSamples = prepare(
    db,
    'INSERT OR REPLACE INTO workout_samples (workout_id, points, data) VALUES (?, ?, ?)',
  );

  const changed: number[] = [];
  let minTs = Infinity;
  const write = (a: FitActivity, file: FitFile, side: FitSidecar | null) => {
    const by = new Map(a.stats.map((s) => [s.type.replace('HKQuantityTypeIdentifier', ''), s]));
    const pick = (...types: string[]) => types.map((t) => by.get(t)).find(Boolean);
    const distance = a.stats.find((s) => s.unit === 'm' && s.type.includes('Distance'))?.sum ?? null;
    const hr = by.get('HeartRate');
    const power = pick('CyclingPower', 'RunningPower');
    const label = [a.manufacturer, a.product && !a.product.startsWith('#') ? a.product : null]
      .filter(Boolean)
      .join(' ');
    const device = side?.device?.trim() || label || 'FIT device';
    const tz = a.tzMin ?? tzOffsetMinutes(localZone, a.startTs) ?? 0;
    const name = side?.name?.trim().slice(0, 200) || '';
    const r = ins.run(
      athleteId,
      a.extKey,
      a.activityType,
      a.sport,
      name,
      side?.notes?.trim() || null,
      name ? 1 : 0,
      a.startTs,
      a.endTs,
      tz,
      null,
      a.durationS,
      distance,
      by.get('ActiveEnergyBurned')?.sum ?? null,
      hr?.average ?? null,
      hr?.minimum ?? null,
      hr?.maximum ?? null,
      power?.average ?? null,
      power?.maximum ?? null,
      by.get('CyclingCadence')?.average ?? null,
      by.get('SwimmingStrokeCount')?.sum ?? null,
      a.lapLengthM,
      a.indoor ? 1 : 0,
      device,
      a.softwareVersion,
      device,
      JSON.stringify({ ...a.meta, FitFile: path.basename(file.path) }),
      JSON.stringify(a.stats),
    );
    stats.workoutsSeen++;
    if (!Number(r.changes)) return; // already imported (same device + start time)
    const id = Number(r.lastInsertRowid);
    stats.workoutsInserted++;
    changed.push(id);
    if (a.startTs < minTs) minTs = a.startTs;
    a.events.forEach((e, idx) => insEvent.run(id, idx, e.type, e.ts, null));
    if (a.track) {
      const n = a.track.t.length;
      insRoute.run(
        id,
        `fit:${path.basename(file.path)}`,
        n,
        Math.floor(a.track.t[0]!),
        Math.ceil(a.track.t[n - 1]!),
        encodeTrack(a.track),
      );
      stats.routesParsed++;
    }
    if (a.samples) insSamples.run(id, a.samples.t.length, encodeSamples(a.samples));
  };

  let done = 0;
  let lastReport = 0;
  const pending: { a: FitActivity; file: FitFile; side: FitSidecar | null }[] = [];
  const flush = () => {
    if (!pending.length) return;
    tx(db, () => {
      for (const p of pending) write(p.a, p.file, p.side);
    });
    pending.length = 0;
  };
  o.onProgress?.({ phase: 'parse', fraction: 0, message: `Reading ${src.files.length} FIT files`, stats });
  try {
    for (const file of src.files) {
      check();
      try {
        const a = parseFit(await file.read());
        pending.push({ a, file, side: await file.sidecar() });
      } catch (e) {
        const msg = e instanceof FitError ? e.message : `Unreadable FIT file (${(e as Error).message})`;
        warn(`${path.basename(file.path)}: ${msg}`, msg);
      }
      done++;
      stats.bytesProcessed = done;
      if (pending.length >= 20) flush();
      const now = Date.now();
      if (now - lastReport > 200) {
        lastReport = now;
        o.onProgress?.({
          phase: 'parse',
          fraction: done / src.files.length,
          message: `FIT files ${done} / ${src.files.length}`,
          stats,
        });
      }
    }
    flush();
  } finally {
    src.close();
  }
  stats.warnings = stats.warnings.map((w) => {
    const key = [...warnCounts.keys()].find((k) => w.endsWith(k));
    const n = key ? warnCounts.get(key)! : 1;
    return n > 1 ? `${w} (×${n})` : w;
  });
  o.onProgress?.({ phase: 'finalize', fraction: 1, message: 'Import finished', stats });
  return {
    stats,
    changedWorkoutIds: changed.sort((a, b) => a - b),
    newWorkoutIds: [...changed],
    sinceDay: Number.isFinite(minTs) ? dayString(Math.floor(minTs / 86400) - 1) : null,
    typeSince: new Map(),
    elapsedMs: Date.now() - t0,
  };
}
