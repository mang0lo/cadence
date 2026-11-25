import type { ActivityAnalysis, WorkoutStreams } from '@cadence/shared';
import { all, get, json, run, tx, type Db } from '../../db/db';
import { getSettings } from '../../core/settings';
import type { DeriveContext } from '../types';
import { gunzipJson, gzipJson } from '../../lib/gzip';
import { analyzeActivity, withFtp, type AnalysisEvent } from './analysis';

/**
 * Bump when the analysis algorithm changes: cached rows with an older key are recomputed on access, by the next
 * derive run and right after the server starts (a background derive, see routes.ts).
 * 2: climbs and lap climbing never across a track break, power peaks from the power curve (glitches ignored),
 *    decoupling without the warm-up (one definition with Progress → Trends), efficiency basis and pace efficiency
 *    stored.
 */
export const ANALYSIS_VERSION = 2;

/**
 * SQL condition for other features reading the stored columns (decoupling_pct, pace_efficiency …): the row `alias`
 * was computed by the current algorithm. Rows of an older version are recomputed in the background.
 */
export function currentAnalysisSql(alias: string): string {
  return `${alias}.cache_key LIKE '${ANALYSIS_VERSION}|%'`;
}

interface WorkoutRow {
  id: number;
  athlete_id: number;
  sport: string;
  start_ts: number;
  end_ts: number;
  lap_length_m: number | null;
  derived_version: number;
  updated_at: number;
}

const WORKOUT_COLS = 'id, athlete_id, sport, start_ts, end_ts, lap_length_m, derived_version, updated_at';
const WORKOUT_COLS_W = WORKOUT_COLS.split(', ')
  .map((c) => `w.${c}`)
  .join(', ');

interface StreamMeta {
  version: number;
  points: number;
}

/**
 * Cache key: algorithm version + the workout's derived version + its last update (core derivation and every PATCH
 * touch updated_at) + the stored stream's version/size.
 */
export function analysisKey(w: Pick<WorkoutRow, 'derived_version' | 'updated_at'>, streams: StreamMeta | null): string {
  return `${ANALYSIS_VERSION}|${w.derived_version}|${w.updated_at}|${streams ? `${streams.version}:${streams.points}` : '-'}`;
}

function streamMeta(db: Db, id: number): StreamMeta | null {
  return get<StreamMeta>(db, 'SELECT version, points FROM workout_streams WHERE workout_id = ?', [id]) ?? null;
}

/** Compute the analysis of one workout from its stored streams and events (no caching). */
export function computeAnalysis(db: Db, w: WorkoutRow): ActivityAnalysis {
  const blob = get<{ data: Uint8Array }>(db, 'SELECT data FROM workout_streams WHERE workout_id = ?', [w.id])?.data;
  let streams: WorkoutStreams = { t: [] };
  if (blob) {
    try {
      streams = gunzipJson<WorkoutStreams>(blob);
    } catch {
      streams = { t: [] };
    }
  }
  const events: AnalysisEvent[] = all<{ type: string; ts: number; duration_s: number | null; meta: string | null }>(
    db,
    'SELECT type, ts, duration_s, meta FROM workout_events WHERE workout_id = ? ORDER BY idx',
    [w.id],
  ).map((e) => ({ type: e.type, ts: e.ts, durationS: e.duration_s, meta: json<Record<string, string> | null>(e.meta, null) }));
  const r = analyzeActivity({
    sport: w.sport,
    startTs: w.start_ts,
    endTs: w.end_ts,
    lapLengthM: w.lap_length_m,
    streams,
    events,
  });
  return { workoutId: w.id, computedAt: Math.floor(Date.now() / 1000), ...r };
}

function store(db: Db, w: WorkoutRow, key: string, a: ActivityAnalysis): void {
  run(
    db,
    `INSERT INTO activities_analysis
       (workout_id, athlete_id, cache_key, efficiency, efficiency_basis, pace_efficiency, decoupling_pct, gap_speed,
        avg_speed, np_w, climb_count, climb_gain_m, data, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workout_id) DO UPDATE SET
       athlete_id = excluded.athlete_id, cache_key = excluded.cache_key, efficiency = excluded.efficiency,
       efficiency_basis = excluded.efficiency_basis, pace_efficiency = excluded.pace_efficiency,
       decoupling_pct = excluded.decoupling_pct, gap_speed = excluded.gap_speed, avg_speed = excluded.avg_speed,
       np_w = excluded.np_w, climb_count = excluded.climb_count, climb_gain_m = excluded.climb_gain_m,
       data = excluded.data, computed_at = excluded.computed_at`,
    [
      w.id,
      w.athlete_id,
      key,
      a.efficiency?.value ?? null,
      a.efficiency?.basis ?? null,
      a.paceEfficiency?.value ?? null,
      a.decoupling?.pct ?? null,
      a.gapSpeed,
      a.avgSpeed,
      a.power?.normalizedW ?? null,
      a.climbs.length,
      a.climbs.reduce((s, c) => s + c.gainM, 0),
      gzipJson(a),
      a.computedAt,
    ],
  );
}

/** Recompute and cache the analysis of a workout. */
export function refreshAnalysis(db: Db, w: WorkoutRow): ActivityAnalysis {
  const a = computeAnalysis(db, w);
  store(db, w, analysisKey(w, streamMeta(db, w.id)), a);
  return a;
}

/**
 * Cached analysis of a workout (recomputed when the cache key changed), with FTP dependent power values added
 * for rides. Null when the workout does not exist.
 */
export function getAnalysis(db: Db, athleteId: number, id: number): ActivityAnalysis | null {
  const w = get<WorkoutRow>(db, `SELECT ${WORKOUT_COLS} FROM workouts WHERE id = ? AND athlete_id = ?`, [id, athleteId]);
  if (!w) return null;
  const key = analysisKey(w, streamMeta(db, id));
  const cached = get<{ cache_key: string; data: Uint8Array }>(
    db,
    'SELECT cache_key, data FROM activities_analysis WHERE workout_id = ?',
    [id],
  );
  let a: ActivityAnalysis | null = null;
  if (cached && cached.cache_key === key) {
    try {
      a = gunzipJson<ActivityAnalysis>(cached.data);
    } catch {
      a = null;
    }
  }
  a ??= refreshAnalysis(db, w);
  if (a.power && (w.sport === 'ride' || w.sport === 'handcycle')) {
    const ftp = getSettings(db, athleteId).ftp;
    const moving = get<{ m: number | null }>(db, 'SELECT moving_s AS m FROM workouts WHERE id = ?', [id])?.m ?? 0;
    a = { ...a, power: withFtp(a.power, ftp, moving) };
  }
  return a;
}

interface KeyRow extends WorkoutRow {
  s_version: number | null;
  s_points: number | null;
  cache_key: string | null;
}

/** Every workout of the athlete with its expected and its stored cache key (one indexed pass). */
function keyRows(db: Db, athleteId: number): (KeyRow & { key: string })[] {
  return all<KeyRow>(
    db,
    `SELECT ${WORKOUT_COLS_W}, s.version AS s_version, s.points AS s_points, a.cache_key
     FROM workouts w LEFT JOIN workout_streams s ON s.workout_id = w.id LEFT JOIN activities_analysis a ON a.workout_id = w.id
     WHERE w.athlete_id = ? ORDER BY w.start_ts`,
    [athleteId],
  ).map((r) => ({
    ...r,
    key: analysisKey(r, r.s_version === null ? null : { version: r.s_version, points: r.s_points ?? 0 }),
  }));
}

/** The key without the update time: it only differs when the algorithm, the derivation or the streams changed. */
const keyCore = (key: string) => key.split('|').filter((_, i) => i !== 2).join('|');

/**
 * Workouts whose cached analysis is missing or computed from something else: an older algorithm, an older
 * derivation or other streams (a cancelled import, a failed analysis step). Renaming a workout (a newer updated_at
 * alone) does not count: the activity page refreshes such a row when it is opened.
 */
export function staleAnalyses(db: Db, athleteId: number): number[] {
  return keyRows(db, athleteId)
    .filter((r) => r.cache_key === null || keyCore(r.cache_key) !== keyCore(r.key))
    .map((r) => r.id);
}

/** Athletes with stale analyses (checked when the server starts). */
export function athletesWithStaleAnalyses(db: Db): number[] {
  const ids = all<{ athlete_id: number }>(db, 'SELECT DISTINCT athlete_id FROM workouts').map((r) => r.athlete_id);
  return ids.filter((id) => staleAnalyses(db, id).length > 0);
}

/**
 * Derive step: (re)compute the analysis of the changed workouts plus every workout whose cached key is missing or
 * outdated (catch-up). A full run ('all') only recomputes changed keys: the analysis depends on nothing else (HR
 * settings, other workouts). Each batch is computed first and written in a short transaction.
 */
export function deriveAnalyses(ctx: DeriveContext): void {
  const { db, athleteId } = ctx;
  const listed = ctx.workoutIds === 'all' ? null : new Set(ctx.workoutIds);
  const rows = keyRows(db, athleteId).filter((r) => listed?.has(r.id) || r.cache_key !== r.key);
  const BATCH = 25;
  for (let i = 0; i < rows.length; i += BATCH) {
    ctx.checkCancelled();
    const slice = rows.slice(i, i + BATCH);
    const done = slice.map((w) => ({ w, a: computeAnalysis(db, w) }));
    tx(db, () => {
      for (const { w, a } of done) store(db, w, w.key, a);
    });
    ctx.report(Math.min(1, (i + slice.length) / rows.length), `${Math.min(rows.length, i + slice.length)} / ${rows.length}`);
  }
  if (!rows.length) ctx.report(1);
}
