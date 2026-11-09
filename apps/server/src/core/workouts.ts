import type {
  BestEffort,
  Split,
  SubActivity,
  WorkoutDetail,
  WorkoutEvent,
  WorkoutStatistic,
  WorkoutStreams,
  WorkoutSummary,
} from '@cadence/shared';
import { trainingKind } from '@cadence/shared';
import { all, get, json, type Db } from '../db/db';
import { haversine } from '../lib/geo';
import { gunzipJson } from '../lib/gzip';
import { placeNameAt } from '../lib/places';

/** Columns of `workouts` needed for WorkoutSummary. */
export const SUMMARY_COLS = `id, name, sport, activity_type, start_ts, end_ts, tz_min, duration_s, moving_s, distance_m,
  energy_kcal, elevation_gain_m, avg_hr, max_hr, avg_speed, effort, effort_estimated, indoor, has_route, polyline,
  source_name, notes, hidden, duplicate_of, start_lat, start_lon, end_lat, end_lon, place, place_end,
  countries, hard_reps, hr_zones, temperature_c, humidity_pct`;

export interface WorkoutRow {
  id: number;
  name: string;
  sport: string;
  activity_type: string;
  start_ts: number;
  end_ts: number;
  tz_min: number;
  duration_s: number;
  moving_s: number | null;
  distance_m: number | null;
  energy_kcal: number | null;
  elevation_gain_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_speed: number | null;
  effort: number | null;
  effort_estimated: number;
  indoor: number;
  has_route: number;
  polyline: string | null;
  source_name: string | null;
  notes: string | null;
  hidden: number;
  duplicate_of: number | null;
  start_lat: number | null;
  start_lon: number | null;
  end_lat: number | null;
  end_lon: number | null;
  /** Start place and, for one-way activities, where it ended (stored by the derive step, see computePlaces). */
  place: string | null;
  place_end: string | null;
  /** "|DE|AT|" */
  countries: string | null;
  hard_reps: number | null;
  hr_zones: string | null;
  temperature_c: number | null;
  humidity_pct: number | null;
}

export interface WorkoutFullRow extends WorkoutRow {
  athlete_id: number;
  timezone: string | null;
  min_hr: number | null;
  max_speed: number | null;
  avg_cadence: number | null;
  avg_power: number | null;
  max_power: number | null;
  elevation_loss_m: number | null;
  step_count: number | null;
  swim_strokes: number | null;
  lap_length_m: number | null;
  temperature_c: number | null;
  humidity_pct: number | null;
  source_version: string | null;
  device: string | null;
  min_lat: number | null;
  min_lon: number | null;
  max_lat: number | null;
  max_lon: number | null;
  hr_zones: string | null;
  stats: string | null;
  meta: string | null;
}

/** One-way activities end at least this far from the start to be named "A → B". */
const ONE_WAY_MIN_M = 2000;

/**
 * Start place and, for one-way activities, the place where it ended (offline gazetteer). Stored in
 * workouts.place / place_end by the derive step so lists can search them.
 */
export function computePlaces(
  startLat: number | null,
  startLon: number | null,
  endLat: number | null,
  endLon: number | null,
): { place: string | null; placeEnd: string | null } {
  const place = placeNameAt(startLat, startLon);
  if (!place || endLat === null || endLon === null || startLat === null || startLon === null)
    return { place, placeEnd: null };
  if (haversine(startLat, startLon, endLat, endLon) < ONE_WAY_MIN_M) return { place, placeEnd: null };
  const end = placeNameAt(endLat, endLon);
  return { place, placeEnd: end && end !== place ? end : null };
}

export function toSummary(r: WorkoutRow): WorkoutSummary {
  return {
    place: r.place,
    placeEnd: r.place_end,
    trainingKind: trainingKind({
      sport: r.sport,
      movingS: r.moving_s ?? r.duration_s,
      distanceM: r.distance_m,
      zones: json<number[] | null>(r.hr_zones, null),
      hardReps: r.hard_reps,
    }),
    countries: r.countries ? r.countries.split('|').filter(Boolean) : [],
    weather:
      r.temperature_c !== null && !r.indoor ? { temperatureC: r.temperature_c, humidityPct: r.humidity_pct } : null,
    id: r.id,
    name: r.name,
    sport: r.sport,
    activityType: r.activity_type,
    startTs: r.start_ts,
    endTs: r.end_ts,
    tzMin: r.tz_min,
    durationS: r.duration_s,
    elapsedS: r.end_ts - r.start_ts,
    movingS: r.moving_s,
    distanceM: r.distance_m,
    energyKcal: r.energy_kcal,
    elevationGainM: r.elevation_gain_m,
    avgHr: r.avg_hr,
    maxHr: r.max_hr,
    avgSpeed: r.avg_speed,
    effort: r.effort,
    effortEstimated: !!r.effort_estimated,
    indoor: !!r.indoor,
    hasRoute: !!r.has_route,
    polyline: r.polyline,
    sourceName: r.source_name,
    notes: r.notes,
    hidden: !!r.hidden,
    duplicateOf: r.duplicate_of,
  };
}

function splitsOf(db: Db, id: number, unit: 'km' | 'mi'): Split[] {
  return all<{
    idx: number;
    distance_m: number;
    elapsed_s: number;
    moving_s: number;
    elev_diff_m: number | null;
    avg_hr: number | null;
    avg_speed: number;
  }>(db, 'SELECT * FROM workout_splits WHERE workout_id = ? AND unit = ? ORDER BY idx', [id, unit]).map(
    (s) => ({
      idx: s.idx,
      distanceM: s.distance_m,
      elapsedS: s.elapsed_s,
      movingS: s.moving_s,
      elevDiffM: s.elev_diff_m,
      avgHr: s.avg_hr,
      avgSpeed: s.avg_speed,
    }),
  );
}

/** Best efforts of a workout with their all-time rank (1–3) among the athlete's visible workouts. */
export function bestEffortsOf(
  db: Db,
  w: { id: number; hidden: number; duplicate_of: number | null },
): BestEffort[] {
  const rows = all<{
    effort: string;
    distance_m: number;
    elapsed_s: number;
    start_offset_s: number;
    rank: number;
  }>(
    db,
    `SELECT be.effort, be.distance_m, be.elapsed_s, be.start_offset_s,
       1 + (SELECT COUNT(*) FROM best_efforts b2 JOIN workouts w2 ON w2.id = b2.workout_id
            WHERE b2.athlete_id = be.athlete_id AND b2.sport = be.sport AND b2.effort = be.effort
              AND w2.hidden = 0 AND w2.duplicate_of IS NULL
              AND (b2.elapsed_s < be.elapsed_s OR (b2.elapsed_s = be.elapsed_s AND b2.workout_id < be.workout_id))) AS rank
     FROM best_efforts be WHERE be.workout_id = ? ORDER BY be.distance_m`,
    [w.id],
  );
  const visible = !w.hidden && w.duplicate_of === null;
  return rows.map((r) => ({
    effort: r.effort,
    distanceM: r.distance_m,
    elapsedS: r.elapsed_s,
    startOffsetS: r.start_offset_s,
    rank: visible && r.rank <= 3 ? r.rank : null,
  }));
}

export function getWorkoutDetail(db: Db, athleteId: number, id: number): WorkoutDetail | null {
  const r = get<WorkoutFullRow>(db, 'SELECT * FROM workouts WHERE id = ? AND athlete_id = ?', [
    id,
    athleteId,
  ]);
  if (!r) return null;
  const events: WorkoutEvent[] = all<{
    type: string;
    ts: number;
    duration_s: number | null;
    meta: string | null;
  }>(db, 'SELECT type, ts, duration_s, meta FROM workout_events WHERE workout_id = ? ORDER BY idx', [id]).map(
    (e) => ({
      type: e.type,
      ts: e.ts,
      durationS: e.duration_s,
      meta: json<Record<string, string> | null>(e.meta, null),
    }),
  );
  const activities: SubActivity[] = all<{
    idx: number;
    activity_type: string;
    sport: string;
    start_ts: number;
    end_ts: number;
    duration_s: number | null;
    stats: string | null;
  }>(db, 'SELECT * FROM workout_activities WHERE workout_id = ? ORDER BY idx', [id]).map((a) => ({
    idx: a.idx,
    activityType: a.activity_type,
    sport: a.sport,
    startTs: a.start_ts,
    endTs: a.end_ts,
    durationS: a.duration_s,
    stats: json<WorkoutStatistic[]>(a.stats, []),
  }));
  const hasBounds = r.min_lat !== null && r.min_lon !== null && r.max_lat !== null && r.max_lon !== null;
  return {
    ...toSummary(r),
    timezone: r.timezone,
    minHr: r.min_hr,
    maxSpeed: r.max_speed,
    avgCadence: r.avg_cadence,
    avgPower: r.avg_power,
    maxPower: r.max_power,
    elevationLossM: r.elevation_loss_m,
    stepCount: r.step_count,
    swimStrokes: r.swim_strokes,
    lapLengthM: r.lap_length_m,
    temperatureC: r.temperature_c,
    humidityPct: r.humidity_pct,
    sourceVersion: r.source_version,
    device: r.device,
    bounds: hasBounds ? [r.min_lon!, r.min_lat!, r.max_lon!, r.max_lat!] : null,
    startLatLng: r.start_lat !== null && r.start_lon !== null ? [r.start_lat, r.start_lon] : null,
    endLatLng: r.end_lat !== null && r.end_lon !== null ? [r.end_lat, r.end_lon] : null,
    hrZones: json<number[] | null>(r.hr_zones, null),
    stats: json<WorkoutStatistic[]>(r.stats, []),
    meta: json<Record<string, string>>(r.meta, {}),
    events,
    activities,
    splitsMetric: splitsOf(db, id, 'km'),
    splitsImperial: splitsOf(db, id, 'mi'),
    bestEfforts: bestEffortsOf(db, r),
    duplicateOf: r.duplicate_of,
  };
}

/** Stored gzip(JSON) streams blob of a workout (null when the workout has no stream). */
export function getStreamsBlob(db: Db, athleteId: number, id: number): Uint8Array | null | undefined {
  const w = get<{ id: number }>(db, 'SELECT id FROM workouts WHERE id = ? AND athlete_id = ?', [
    id,
    athleteId,
  ]);
  if (!w) return undefined;
  return (
    get<{ data: Uint8Array }>(db, 'SELECT data FROM workout_streams WHERE workout_id = ?', [id])?.data ?? null
  );
}

export function getStreams(db: Db, athleteId: number, id: number): WorkoutStreams | null {
  const blob = getStreamsBlob(db, athleteId, id);
  if (blob === undefined) return null;
  return blob ? gunzipJson<WorkoutStreams>(blob) : { t: [] };
}
