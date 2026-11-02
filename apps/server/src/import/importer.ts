import type { ImportPhase, ImportStats } from '@cadence/shared';
import { get, prepare, tx, type Db } from '../db/db';
import { gzipFloat32 } from '../lib/gzip';
import { dayString } from '../lib/time';
import { parseEcgCsv } from './ecg';
import { parseGpx } from './gpx';
import { AppleHealthHandler } from './parser';
import { normalizeRelPath, openExportSource, type ExportSource } from './source';
import { encodeTrack, type Track } from './track';
import { emptyStats, ImportWriter } from './writer';
import { scanXmlStream } from './xml';

export interface ImportProgress {
  phase: ImportPhase;
  /** 0..1 progress of the import part (parse → routes → ecg → finalize). */
  fraction: number;
  message: string;
  stats: ImportStats;
}

export interface RunImportOptions {
  db: Db;
  athleteId: number;
  /** export.zip, the unzipped folder, or export.xml */
  path: string;
  onProgress?: (p: ImportProgress) => void;
  /** Throws to abort (checked between batches). */
  checkCancelled?: () => void;
  log?: (message: string) => void;
}

export interface ImportResult {
  stats: ImportStats;
  /** Workouts that are new or got a new route → input for derive. */
  changedWorkoutIds: number[];
  /** Earliest local day with new data (minus one day margin), or null if nothing changed. */
  sinceDay: string | null;
  /** record type id → earliest start_ts of newly inserted records. */
  typeSince: Map<number, number>;
  elapsedMs: number;
}

/** Share of the import part per phase (parse dominates). */
const W_PARSE = 0.86;
const W_ROUTES = 0.11;
const W_ECG = 0.02;

/**
 * Import an Apple Health export into the database (no derivation; see runDerive). Idempotent: re-importing
 * the same or a newer export only inserts what is new.
 */
export async function runImport(o: RunImportOptions): Promise<ImportResult> {
  const t0 = Date.now();
  const stats = emptyStats();
  const check = o.checkCancelled ?? (() => {});
  const log = o.log ?? (() => {});
  let lastReport = 0;
  const report = (phase: ImportPhase, fraction: number, message: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < 200) return;
    lastReport = now;
    o.onProgress?.({ phase, fraction: Math.min(1, Math.max(0, fraction)), message, stats });
  };

  report('scan', 0, 'Opening export', true);
  const src = await openExportSource(o.path);
  try {
    stats.bytesTotal = src.xmlSize;
    log(`Importing ${src.name} (${src.kind}, export.xml ${(src.xmlSize / 1e6).toFixed(1)} MB)`);
    const writer = new ImportWriter(o.db, o.athleteId, stats);

    // ---- export.xml ----
    report('parse', 0, 'Reading export.xml', true);
    const handler = new AppleHealthHandler(writer);
    const xml = await src.openXml();
    await scanXmlStream(xml, handler, (bytes) => {
      stats.bytesProcessed += bytes;
      if (writer.shouldFlush()) {
        check();
        writer.flush();
      }
      const f = stats.bytesTotal ? stats.bytesProcessed / stats.bytesTotal : 0;
      report('parse', W_PARSE * f, `Parsing export.xml – ${stats.recordsSeen.toLocaleString('en')} records`);
    });
    check();
    writer.flush();
    stats.bytesProcessed = Math.max(stats.bytesProcessed, stats.bytesTotal);
    stats.recordTypes = get<{ n: number }>(o.db, 'SELECT COUNT(*) AS n FROM record_types')!.n;
    const changed = new Set<number>(writer.newWorkoutIds);

    // ---- workout routes ----
    report('routes', W_PARSE, 'Reading workout routes', true);
    await importRoutes(o.db, o.athleteId, src, writer, changed, stats, check, (f, msg) =>
      report('routes', W_PARSE + W_ROUTES * f, msg),
    );

    // ---- ECG ----
    report('ecg', W_PARSE + W_ROUTES, 'Reading electrocardiograms', true);
    await importEcgs(o.db, o.athleteId, src, writer, stats, check, (f) =>
      report('ecg', W_PARSE + W_ROUTES + W_ECG * f, 'Reading electrocardiograms'),
    );

    // ---- clinical record resources ----
    report('finalize', W_PARSE + W_ROUTES + W_ECG, 'Finishing import', true);
    await attachClinicalResources(o.db, o.athleteId, src, writer);
    writer.finishWarnings();

    let minTs = writer.minChangedTs;
    if (changed.size) {
      const r = get<{ t: number | null }>(
        o.db,
        `SELECT MIN(start_ts) AS t FROM workouts WHERE id IN (${[...changed].join(',')})`,
      );
      if (r?.t !== null && r?.t !== undefined && r.t < minTs) minTs = r.t;
    }
    const sinceDay = Number.isFinite(minTs) ? dayString(Math.floor(minTs / 86400) - 1) : null;
    report('finalize', 1, 'Import finished', true);
    return {
      stats,
      changedWorkoutIds: [...changed].sort((a, b) => a - b),
      sinceDay,
      typeSince: writer.typeMinTs,
      elapsedMs: Date.now() - t0,
    };
  } finally {
    src.close();
  }
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

async function importRoutes(
  db: Db,
  athleteId: number,
  src: ExportSource,
  writer: ImportWriter,
  changed: Set<number>,
  stats: ImportStats,
  check: () => void,
  progress: (fraction: number, message: string) => void,
): Promise<void> {
  const has = prepare(
    db,
    'SELECT 1 FROM workout_routes WHERE workout_id = ? AND file = ? AND data IS NOT NULL',
  );
  const known = prepare(db, 'SELECT 1 FROM workout_routes WHERE file = ? AND data IS NOT NULL LIMIT 1');
  const upsert = prepare(
    db,
    `INSERT INTO workout_routes (workout_id, file, point_count, start_ts, end_ts, linked_by, data) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workout_id, file) DO UPDATE SET point_count = excluded.point_count, start_ts = excluded.start_ts,
       end_ts = excluded.end_ts, linked_by = excluded.linked_by, data = excluded.data`,
  );
  const referenced = new Set(writer.routeRefs.map((r) => normalizeRelPath(r.path).toLowerCase()));
  const todo = writer.routeRefs.filter((r) => {
    const f = src.find(r.path);
    return !has.get(r.workoutId, f ? f.path : normalizeRelPath(r.path));
  });
  const unreferenced = src
    .list('workout-routes', '.gpx')
    .filter((f) => !referenced.has(f.path.toLowerCase()) && !known.get(f.path));
  const total = todo.length + unreferenced.length + writer.inlineTracks.length;
  let done = 0;
  let missing = 0;
  const pending: { workoutId: number; file: string; track: Track; linkedBy: string }[] = [];
  const flush = () => {
    if (!pending.length) return;
    tx(db, () => {
      for (const p of pending) {
        const n = p.track.t.length;
        upsert.run(
          p.workoutId,
          p.file,
          n,
          Math.floor(p.track.t[0]!),
          Math.ceil(p.track.t[n - 1]!),
          p.linkedBy,
          encodeTrack(p.track),
        );
        changed.add(p.workoutId);
        stats.routesParsed++;
      }
    });
    pending.length = 0;
  };
  const readTrack = async (path: string): Promise<Track | null> => {
    try {
      const buf = await src.read(path);
      const tr = parseGpx(buf.toString('utf8'));
      if (tr.t.length < 2) {
        writer.warn(`Route without usable points: ${path}`);
        return null;
      }
      return tr;
    } catch (e) {
      writer.warn(`Unreadable route ${path}: ${(e as Error).message}`);
      return null;
    }
  };

  for (const ref of todo) {
    check();
    const f = src.find(ref.path);
    done++;
    if (!f) {
      missing++;
      continue;
    }
    const tr = await readTrack(f.path);
    if (tr) pending.push({ workoutId: ref.workoutId, file: f.path, track: tr, linkedBy: 'reference' });
    if (pending.length >= 20) flush();
    progress(done / Math.max(1, total), `Workout routes ${done} / ${total}`);
  }
  flush();
  if (missing) writer.warn(`${missing} referenced route files are missing from the export`);

  // GPX files without a FileReference: attach to the workout with the largest time overlap.
  const overlapQ = prepare(
    db,
    `SELECT id, start_ts, end_ts, (SELECT COUNT(*) FROM workout_routes r WHERE r.workout_id = w.id) AS routes
     FROM workouts w WHERE athlete_id = ? AND start_ts < ? AND end_ts > ?`,
  );
  let unmatched = 0;
  for (const f of unreferenced) {
    check();
    done++;
    const tr = await readTrack(f.path);
    if (tr) {
      const s = tr.t[0]!;
      const e = tr.t[tr.t.length - 1]!;
      const cands = overlapQ.all(athleteId, e, s) as {
        id: number;
        start_ts: number;
        end_ts: number;
        routes: number;
      }[];
      let best: { id: number; ov: number } | null = null;
      for (const c of cands) {
        const ov = Math.min(e, c.end_ts) - Math.max(s, c.start_ts) - (c.routes ? 1e6 : 0);
        if (!best || ov > best.ov) best = { id: c.id, ov };
      }
      const span = Math.max(1, e - s);
      if (best && best.ov > Math.min(60, span * 0.5))
        pending.push({ workoutId: best.id, file: f.path, track: tr, linkedBy: 'overlap' });
      else unmatched++;
    }
    if (pending.length >= 20) flush();
    progress(done / Math.max(1, total), `Workout routes ${done} / ${total}`);
  }
  flush();
  if (unmatched) writer.warn(`${unmatched} route files could not be matched to a workout`);

  for (const it of writer.inlineTracks) {
    if (!has.get(it.workoutId, `inline:${it.workoutId}`))
      pending.push({
        workoutId: it.workoutId,
        file: `inline:${it.workoutId}`,
        track: it.track,
        linkedBy: 'inline',
      });
  }
  flush();
  progress(1, 'Workout routes done');
}

// ---------------------------------------------------------------------------
// ECG
// ---------------------------------------------------------------------------

async function importEcgs(
  db: Db,
  athleteId: number,
  src: ExportSource,
  writer: ImportWriter,
  stats: ImportStats,
  check: () => void,
  progress: (fraction: number) => void,
): Promise<void> {
  const files = src.list('electrocardiograms', '.csv');
  if (!files.length) return;
  const ins = prepare(
    db,
    `INSERT OR IGNORE INTO ecg_readings (athlete_id, recorded_ts, tz_min, classification, symptoms, software_version, device,
       sample_rate_hz, lead, unit, samples, file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let i = 0;
  for (const f of files) {
    check();
    i++;
    try {
      const r = parseEcgCsv((await src.read(f.path)).toString('utf8'));
      if (!r) {
        writer.warn(`ECG without a recording date skipped: ${f.path}`);
        continue;
      }
      const res = ins.run(
        athleteId,
        r.recordedTs,
        r.tzMin,
        r.classification,
        r.symptoms,
        r.softwareVersion,
        r.device,
        r.sampleRateHz,
        r.lead,
        r.unit,
        r.samples.length ? gzipFloat32(r.samples) : null,
        f.path,
      );
      if (Number(res.changes)) stats.ecgReadings++;
    } catch (e) {
      writer.warn(`Unreadable ECG ${f.path}: ${(e as Error).message}`);
    }
    progress(i / files.length);
  }
}

// ---------------------------------------------------------------------------
// clinical records (FHIR JSON referenced by <ClinicalRecord resourceFilePath=…>)
// ---------------------------------------------------------------------------

async function attachClinicalResources(
  db: Db,
  athleteId: number,
  src: ExportSource,
  writer: ImportWriter,
): Promise<void> {
  if (!writer.clinicalRefs.length) return;
  const upd = prepare(
    db,
    `UPDATE health_items SET data = json_set(data, '$.resource', json(?))
     WHERE athlete_id = ? AND kind = 'ClinicalRecord' AND hash = ? AND json_extract(data, '$.resource') IS NULL`,
  );
  for (const ref of writer.clinicalRefs) {
    const f = src.find(ref.path);
    if (!f || f.size > 5 * 1024 * 1024) continue;
    try {
      const text = (await src.read(f.path)).toString('utf8');
      JSON.parse(text);
      upd.run(text, athleteId, ref.hash);
    } catch {
      writer.warn(`Unreadable clinical resource ${ref.path}`);
    }
  }
}
