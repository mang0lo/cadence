import {
  MIN_SEGMENT_M,
  profileSlice,
  segmentSports,
  valueAtDistance,
  type MapsSegmentEffort,
} from '@cadence/shared';
import { getStreams } from '../../core/workouts';
import { trackParts } from '../../derive/streams';
import { all, get, prepare, run, tx, type Db } from '../../db/db';
import { badRequest, notFound } from '../../lib/http';
import {
  bounds,
  decodePolylineParts,
  distanceToPath,
  encodePolylineArrays,
  simplifyIndices,
  type LatLon,
} from '../../lib/geo';
import { gunzipJson, gzipJson } from '../../lib/gzip';
import type { DeriveStep } from '../types';
import { GATE_RADIUS_M, matchSegment, sliceStream, thinPath, type SegmentPath } from './segment-match';
import { IN_LIST, idList, visible } from './sql';

export interface SegmentRow {
  id: number;
  athlete_id: number;
  name: string;
  sport: string;
  source_workout_id: number | null;
  distance_m: number;
  elevation_gain_m: number | null;
  elevation_loss_m: number | null;
  avg_grade: number | null;
  start_lat: number;
  start_lon: number;
  end_lat: number;
  end_lon: number;
  min_lat: number;
  min_lon: number;
  max_lat: number;
  max_lon: number;
  polyline: string;
  starred: number;
  created_at: number;
}

const COLS = `id, athlete_id, name, sport, source_workout_id, distance_m, elevation_gain_m, elevation_loss_m, avg_grade,
  start_lat, start_lon, end_lat, end_lon, min_lat, min_lon, max_lat, max_lon, polyline, starred, created_at`;

export const segmentRows = (db: Db, athleteId: number, ids?: number[]): SegmentRow[] =>
  all<SegmentRow>(
    db,
    `SELECT ${COLS} FROM maps_segments WHERE athlete_id = ?${ids ? ` AND id IN ${IN_LIST}` : ''} ORDER BY id`,
    ids ? [athleteId, idList(ids)] : [athleteId],
  );

/** What the `path` blob holds: the thinned course (matching) and the elevation profile of the dense track (display). */
export interface StoredPath extends SegmentPath {
  prof: { dist: number[]; ele: (number | null)[] };
}

export function loadPath(db: Db, segmentId: number): StoredPath {
  const r = get<{ path: Uint8Array }>(db, 'SELECT path FROM maps_segments WHERE id = ?', [segmentId]);
  if (!r) throw notFound('Segment');
  const p = gunzipJson<StoredPath>(r.path);
  // a path stored before the profile existed: flat, unknown elevation
  p.prof ??= { dist: [0, p.dist[p.dist.length - 1] ?? 0], ele: [null, null] };
  return p;
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const r1 = (x: number) => Math.round(x * 10) / 10;

export interface NewSegment {
  workoutId: number;
  startM: number;
  endM: number;
  name: string;
}

/**
 * Cut the segment out of a workout's route, store it and match it against every compatible GPS workout. The matching
 * runs in short slices that give the event loop a turn in between, so other requests are not held up meanwhile.
 */
export async function createSegment(
  db: Db,
  athleteId: number,
  input: NewSegment,
  opts: { sliceMs?: number } = {},
): Promise<number> {
  const w = get<{ id: number; sport: string }>(
    db,
    'SELECT id, sport FROM workouts WHERE id = ? AND athlete_id = ?',
    [input.workoutId, athleteId],
  );
  if (!w) throw notFound('Workout');
  const s = getStreams(db, athleteId, w.id);
  if (!s?.lat || !s.lon || !s.dist || s.lat.length < 2) throw badRequest('This activity has no GPS route');
  const total = s.dist[s.dist.length - 1]!;
  const startM = Math.max(0, Math.min(total, input.startM));
  const endM = Math.max(0, Math.min(total, input.endM));
  if (endM - startM < MIN_SEGMENT_M) throw badRequest(`A segment has to be at least ${MIN_SEGMENT_M} m long`);
  // the distance does not grow across a break (travelled while paused): a segment cannot bridge it
  for (const k of s.breaks ?? []) {
    const at = s.dist[k];
    if (at !== undefined && at > startM && at < endM)
      throw badRequest('A segment has to lie within one part of the activity (it was paused and continued elsewhere)');
  }

  const dense = sliceStream({ lat: s.lat, lon: s.lon, dist: s.dist, ele: s.ele }, startM, endM);
  const stats = profileSlice(s.dist, s.ele ?? null, startM, endM);
  const thin = thinPath(dense, 1.5);
  const display = simplifyIndices(dense.lat, dense.lon, 5);
  const bb = bounds(dense.lat, dense.lon)!;
  // Douglas–Peucker thinning ignores elevation, so the profile is sampled from the dense track (≤ 300 points)
  const length = endM - startM;
  const step = Math.max(5, length / 300);
  const profN = Math.floor(length / step) + 1;
  const prof: StoredPath['prof'] = { dist: [], ele: [] };
  for (let k = 0; k <= profN; k++) {
    const d = k === profN ? length : k * step;
    if (k === profN && d - prof.dist[prof.dist.length - 1]! < 1) break;
    prof.dist.push(r1(d));
    const v = valueAtDistance(dense.dist, dense.ele ?? [], d);
    prof.ele.push(v === null ? null : r1(v));
  }
  const stored: StoredPath = {
    lat: thin.lat.map(r6),
    lon: thin.lon.map(r6),
    dist: thin.dist.map(r1),
    prof,
  };
  const last = dense.lat.length - 1;
  const id = tx(db, () => {
    const r = run(
      db,
      `INSERT INTO maps_segments (athlete_id, name, sport, source_workout_id, distance_m, elevation_gain_m, elevation_loss_m,
         avg_grade, start_lat, start_lon, end_lat, end_lon, min_lat, min_lon, max_lat, max_lon, polyline, path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        athleteId,
        input.name.trim(),
        w.sport,
        w.id,
        Math.round((endM - startM) * 10) / 10,
        s.ele ? Math.round(stats.gainM * 10) / 10 : null,
        s.ele ? Math.round(stats.lossM * 10) / 10 : null,
        stats.gradePct === null ? null : Math.round(stats.gradePct * 100) / 100,
        dense.lat[0]!,
        dense.lon[0]!,
        dense.lat[last]!,
        dense.lon[last]!,
        bb[1],
        bb[0],
        bb[3],
        bb[2],
        encodePolylineArrays(dense.lat, dense.lon, display),
        gzipJson(stored),
      ],
    );
    return r.lastInsertRowid;
  });
  await matchWorkoutsAsync(db, athleteId, segmentRows(db, athleteId, [id]), 'all', opts);
  return id;
}

interface CandidateWorkout {
  id: number;
  sport: string;
  start_ts: number;
  min_lat: number;
  min_lon: number;
  max_lat: number;
  max_lon: number;
  polyline: string | null;
}

/** Gate slack for the prefilters: polylines are simplified (5 m) and bounding boxes are exact. */
const PAD_M = GATE_RADIUS_M + 15;

interface Prepared {
  row: SegmentRow;
  path: SegmentPath;
  sports: string[];
  /** Bounding box padded by PAD_M, in degrees. */
  box: [minLat: number, minLon: number, maxLat: number, maxLon: number];
  start: LatLon;
  end: LatLon;
}

function preparePath(db: Db, row: SegmentRow): Prepared {
  const padLat = PAD_M / 111_195;
  const padLon = PAD_M / (111_195 * Math.max(0.2, Math.cos((row.start_lat * Math.PI) / 180)));
  return {
    row,
    path: loadPath(db, row.id),
    sports: segmentSports(row.sport),
    box: [row.min_lat - padLat, row.min_lon - padLon, row.max_lat + padLat, row.max_lon + padLon],
    start: [row.start_lat, row.start_lon],
    end: [row.end_lat, row.end_lon],
  };
}

interface MatchRun {
  onProgress?: (done: number, total: number) => void;
  checkCancelled?: () => void;
  /** End a batch (commit) once it took this long; without it a batch holds BATCH workouts. */
  sliceMs?: number;
}

/**
 * Match segments against workouts (ids, or every GPS workout) and replace their stored efforts. A workout's stream is
 * only decoded when at least one segment of a compatible sport has both gates near the workout's (simplified) route.
 * Returns the number of efforts stored.
 */
export function matchWorkouts(
  db: Db,
  athleteId: number,
  segments: SegmentRow[],
  workoutIds: number[] | 'all',
  onProgress?: (done: number, total: number) => void,
  checkCancelled?: () => void,
): number {
  const it = matchBatches(db, athleteId, segments, workoutIds, { onProgress, checkCancelled });
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/**
 * matchWorkouts for request handlers: commits every `sliceMs` (default 20 ms) and lets the event loop serve other
 * requests before it goes on.
 */
export async function matchWorkoutsAsync(
  db: Db,
  athleteId: number,
  segments: SegmentRow[],
  workoutIds: number[] | 'all',
  opts: { sliceMs?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<number> {
  const it = matchBatches(db, athleteId, segments, workoutIds, { sliceMs: 20, ...opts });
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** The matching itself, one committed batch per step (the generator yields between batches). */
function* matchBatches(
  db: Db,
  athleteId: number,
  segments: SegmentRow[],
  workoutIds: number[] | 'all',
  { onProgress, checkCancelled, sliceMs }: MatchRun,
): Generator<void, number, void> {
  if (!segments.length) return 0;
  const prepared = segments.map((r) => preparePath(db, r));
  const segIds = idList(segments.map((s) => s.id));
  const createdAt = new Map(segments.map((s) => [s.id, s.created_at]));
  // one JSON parameter for the workout ids: a first import after a reset (segments are kept) can bring more workouts
  // than SQLite takes parameters
  const some = workoutIds === 'all' ? null : idList(workoutIds);
  const workouts = all<CandidateWorkout>(
    db,
    `SELECT id, sport, start_ts, min_lat, min_lon, max_lat, max_lon, polyline FROM workouts
     WHERE athlete_id = ? AND has_route = 1 AND min_lat IS NOT NULL${some ? ` AND id IN ${IN_LIST}` : ''}
     ORDER BY start_ts`,
    some ? [athleteId, some] : [athleteId],
  );
  // workouts that lost their route (or never had one) must lose their efforts too
  run(
    db,
    `DELETE FROM maps_segment_efforts WHERE segment_id IN ${IN_LIST}${some ? ` AND workout_id IN ${IN_LIST}` : ''}
       AND workout_id NOT IN (SELECT id FROM workouts WHERE has_route = 1)`,
    some ? [segIds, some] : [segIds],
  );
  const del = prepare(db, `DELETE FROM maps_segment_efforts WHERE workout_id = ? AND segment_id IN ${IN_LIST}`);
  const ins = prepare(
    db,
    `INSERT OR REPLACE INTO maps_segment_efforts (segment_id, workout_id, idx, athlete_id, start_ts, elapsed_s, moving_s, avg_hr, avg_speed, track_m)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let stored = 0;
  let live = prepared;
  const matchOne = (w: CandidateWorkout): void => {
    const near = live.filter(
      (p) =>
        p.sports.includes(w.sport) &&
        w.max_lat >= p.box[0] &&
        w.min_lat <= p.box[2] &&
        w.max_lon >= p.box[1] &&
        w.min_lon <= p.box[3],
    );
    del.run(w.id, segIds);
    if (!near.length) return;
    let lines: LatLon[][] | null = null;
    const candidates = near.filter((p) => {
      // both gates must be on (the simplified version of) one part of the workout's route
      lines ??= w.polyline ? decodePolylineParts(w.polyline) : [];
      return lines.some(
        (line) =>
          line.length > 1 &&
          distanceToPath(p.start[0], p.start[1], line) <= PAD_M &&
          distanceToPath(p.end[0], p.end[1], line) <= PAD_M,
      );
    });
    if (!candidates.length) return;
    const s = getStreams(db, athleteId, w.id);
    if (!s?.lat || !s.lon || s.t.length < 2) return;
    // match every part of the track on its own: a pass never bridges a break (travelled while paused)
    const parts = trackParts(s.t.length, s.breaks);
    const slice = <T>(a: T[] | undefined, from: number, to: number) => a?.slice(from, to);
    for (const p of candidates) {
      const matches = parts.flatMap(([from, to]) =>
        to - from < 2
          ? []
          : matchSegment(p.path, {
              t: s.t.slice(from, to),
              lat: s.lat!.slice(from, to),
              lon: s.lon!.slice(from, to),
              dist: slice(s.dist, from, to),
              hr: slice(s.hr, from, to),
              moving: slice(s.moving, from, to),
            }),
      );
      matches.forEach((m, idx) => {
        ins.run(
          p.row.id,
          w.id,
          idx,
          athleteId,
          Math.round((w.start_ts + m.startT) * 10) / 10,
          Math.round(m.elapsedS * 10) / 10,
          m.movingS === null ? null : Math.round(m.movingS * 10) / 10,
          m.avgHr === null ? null : Math.round(m.avgHr * 10) / 10,
          Math.round((p.row.distance_m / m.elapsedS) * 1000) / 1000,
          Math.round(m.trackM),
        );
        stored++;
      });
    }
  };
  const BATCH = 25;
  for (let b = 0; b < workouts.length; ) {
    checkCancelled?.();
    const deadline = sliceMs === undefined ? Infinity : performance.now() + sliceMs;
    const next = tx(db, () => {
      // a segment deleted meanwhile (by the user: another thread or, between slices, another request) is dropped;
      // the others are still matched. One created meanwhile can get the id of a deleted one (SQLite reuses the highest
      // rowid): only the same creation time makes it the segment loaded above.
      const exists = new Set(
        all<{ id: number; created_at: number }>(
          db,
          `SELECT id, created_at FROM maps_segments WHERE id IN ${IN_LIST}`,
          [segIds],
        )
          .filter((r) => r.created_at === createdAt.get(r.id))
          .map((r) => r.id),
      );
      if (exists.size < live.length) live = live.filter((p) => exists.has(p.row.id));
      if (!live.length) return -1;
      const stop = Math.min(workouts.length, b + BATCH);
      let i = b;
      while (i < stop) {
        matchOne(workouts[i++]!);
        if (performance.now() > deadline) break;
      }
      return i;
    });
    if (next < 0) break;
    b = next;
    onProgress?.(b, workouts.length);
    if (b < workouts.length) yield;
  }
  return stored;
}

/** Efforts of new / changed workouts (or all of them) against every segment. */
export const segmentsStep: DeriveStep = {
  id: 'maps.segments',
  label: 'Segment efforts',
  weight: 2,
  run(ctx) {
    const segments = segmentRows(ctx.db, ctx.athleteId);
    if (!segments.length) return;
    if (ctx.workoutIds !== 'all' && ctx.workoutIds.length === 0) return;
    matchWorkouts(
      ctx.db,
      ctx.athleteId,
      segments,
      ctx.workoutIds,
      (done, total) => ctx.report(done / Math.max(1, total), `${done} / ${total}`),
      ctx.checkCancelled,
    );
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Efforts: ranking
// ---------------------------------------------------------------------------------------------------------------

export interface EffortRow {
  segment_id: number;
  workout_id: number;
  idx: number;
  start_ts: number;
  elapsed_s: number;
  moving_s: number | null;
  avg_hr: number | null;
  avg_speed: number;
  name: string;
  sport: string;
  tz_min: number;
}

/**
 * Efforts of visible workouts (hidden and duplicate workouts do not count), optionally of some segments only, or of
 * the segments that one workout has an effort on.
 */
export function effortRows(
  db: Db,
  athleteId: number,
  segmentIds?: number[],
  onSegmentsOf?: number,
): EffortRow[] {
  const where = ['e.athlete_id = ?', visible()];
  const params: unknown[] = [athleteId];
  if (segmentIds) {
    where.push(`e.segment_id IN ${IN_LIST}`);
    params.push(idList(segmentIds));
  }
  if (onSegmentsOf !== undefined) {
    where.push('e.segment_id IN (SELECT segment_id FROM maps_segment_efforts WHERE workout_id = ?)');
    params.push(onSegmentsOf);
  }
  return all<EffortRow>(
    db,
    `SELECT e.segment_id, e.workout_id, e.idx, e.start_ts, e.elapsed_s, e.moving_s, e.avg_hr, e.avg_speed,
            w.name, w.sport, w.tz_min
     FROM maps_segment_efforts e JOIN workouts w ON w.id = e.workout_id
     WHERE ${where.join(' AND ')} ORDER BY e.segment_id, e.start_ts, e.workout_id, e.idx`,
    params,
  );
}

/** Rank (1 = fastest) and "was a PR when ridden" for the chronologically sorted efforts of ONE segment. */
export function rankEfforts(rows: EffortRow[]): MapsSegmentEffort[] {
  const byTime = [...rows].sort((a, b) => a.elapsed_s - b.elapsed_s || a.start_ts - b.start_ts);
  const rank = new Map(byTime.map((e, i) => [`${e.workout_id}:${e.idx}`, i + 1]));
  let best = Infinity;
  const out: MapsSegmentEffort[] = [];
  for (const e of rows) {
    const pr = e.elapsed_s < best;
    if (pr) best = e.elapsed_s;
    out.push({
      workoutId: e.workout_id,
      idx: e.idx,
      name: e.name,
      sport: e.sport,
      startTs: e.start_ts,
      tzMin: e.tz_min,
      elapsedS: e.elapsed_s,
      movingS: e.moving_s,
      avgSpeed: e.avg_speed,
      avgHr: e.avg_hr,
      rank: rank.get(`${e.workout_id}:${e.idx}`)!,
      pr,
    });
  }
  return out;
}
