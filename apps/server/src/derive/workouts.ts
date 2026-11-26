import {
  BEST_EFFORTS,
  BEST_EFFORT_SPORTS,
  M_PER_MI,
  sportInfo,
  type WorkoutStatistic,
} from '@cadence/shared';
import { hardReps } from '@cadence/shared';
import { computePlaces } from '../core/workouts';
import { countriesAlong, placesAlong, placesColumn } from '../lib/places';
import { all, get, json, prepare, run, tx, type Db } from '../db/db';
import type { DeriveStep } from '../features/types';
import { bounds, encodePolylineParts, simplifyIndices, type LatLon } from '../lib/geo';
import { gzipFloat32, gzipJson } from '../lib/gzip';
import { DISTANCE_TYPE_BY_SPORT, parseQuantityString, summarizeStats } from '../import/hk';
import { decodeSamples, distanceIntervals, seriesOf, type SensorSamples } from '../import/samples';
import { decodeTrack, mergeTracks, type Track } from '../import/track';
import { DERIVE_VERSION, STREAMS_VERSION } from './context';
import {
  bestEfforts,
  computeSplits,
  elevationGainLoss,
  hrHistogram,
  movingTime,
  robustMaxSpeed,
} from './metrics';
import {
  buildStreams,
  maxPlausibleSpeed,
  pausedIntervals,
  toDto,
  trackParts,
  type BuiltStreams,
  type Intervals,
  type Samples,
} from './streams';

interface WorkoutRow {
  id: number;
  athlete_id: number;
  sport: string;
  start_ts: number;
  end_ts: number;
  duration_s: number;
  source_name: string | null;
  indoor: number;
  meta: string | null;
  stats: string | null;
}

const Q = (t: string) => `HKQuantityTypeIdentifier${t}`;

/** Per-run caches (type ids, source ids). */
export class DeriveCache {
  private typeIds = new Map<string, number | null>();
  private sourceIds = new Map<string, number | null>();
  constructor(private readonly db: Db) {}
  typeId(identifier: string): number | null {
    if (!this.typeIds.has(identifier)) {
      this.typeIds.set(
        identifier,
        get<{ id: number }>(this.db, 'SELECT id FROM record_types WHERE identifier = ?', [identifier])?.id ??
          null,
      );
    }
    return this.typeIds.get(identifier)!;
  }
  sourceId(name: string | null): number | null {
    if (!name) return null;
    if (!this.sourceIds.has(name)) {
      this.sourceIds.set(
        name,
        get<{ id: number }>(this.db, 'SELECT id FROM sources WHERE name = ?', [name])?.id ?? null,
      );
    }
    return this.sourceIds.get(name)!;
  }
}

interface RawSample {
  start_ts: number;
  end_ts: number;
  value: number;
  source_id: number;
}

/** Records of a type inside [from, to], restricted to one source: the workout's own if it has enough, else the busiest. */
function loadRecords(
  db: Db,
  athleteId: number,
  typeId: number | null,
  from: number,
  to: number,
  preferSource: number | null,
): RawSample[] {
  if (typeId === null) return [];
  const rows = prepare(
    db,
    `SELECT start_ts, end_ts, value, source_id FROM records
     WHERE athlete_id = ? AND type_id = ? AND start_ts >= ? AND start_ts <= ? AND value IS NOT NULL
     ORDER BY start_ts`,
  ).all(athleteId, typeId, from, to) as unknown as RawSample[];
  if (!rows.length) return rows;
  const counts = new Map<number, number>();
  for (const r of rows) counts.set(r.source_id, (counts.get(r.source_id) ?? 0) + 1);
  if (counts.size === 1) return rows;
  let best = rows[0]!.source_id;
  let max = 0;
  for (const [s, c] of counts)
    if (c > max) {
      max = c;
      best = s;
    }
  const own = preferSource !== null ? (counts.get(preferSource) ?? 0) : 0;
  const pick = own >= max * 0.3 && own > 0 ? preferSource! : best;
  return rows.filter((r) => r.source_id === pick);
}

function loadSensorSamples(db: Db, workoutId: number): SensorSamples | null {
  const row = get<{ data: Uint8Array }>(db, 'SELECT data FROM workout_samples WHERE workout_id = ?', [
    workoutId,
  ]);
  if (!row) return null;
  try {
    return decodeSamples(row.data);
  } catch {
    return null; // corrupt blob: fall back to Health records
  }
}

function toSamples(rows: RawSample[]): Samples | null {
  if (!rows.length) return null;
  return { t: Float64Array.from(rows, (r) => r.start_ts), v: Float64Array.from(rows, (r) => r.value) };
}

function toIntervals(rows: RawSample[]): Intervals | null {
  if (!rows.length) return null;
  return {
    s: Float64Array.from(rows, (r) => r.start_ts),
    e: Float64Array.from(rows, (r) => r.end_ts),
    v: Float64Array.from(rows, (r) => r.value),
  };
}

/** Sum of the records inside [from, to]; a record reaching over either end counts with its share inside. */
function sumOf(rows: RawSample[], from: number, to: number): number | null {
  let s = 0;
  let any = false;
  for (const r of rows) {
    const d = r.end_ts - r.start_ts;
    if (d > 0) {
      const inside = Math.min(r.end_ts, to) - Math.max(r.start_ts, from);
      if (inside <= 0) continue;
      s += (r.value * inside) / d;
    } else if (r.start_ts >= from && r.start_ts <= to) s += r.value;
    else continue;
    any = true;
  }
  return any ? s : null;
}

const round = (x: number | null | undefined, d = 1) =>
  x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;

function nanStats(
  a: Float64Array | null,
  t: Float64Array,
): { avg: number | null; min: number | null; max: number | null } {
  if (!a) return { avg: null, min: null, max: null };
  let sum = 0;
  let w = 0;
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!;
    if (v !== v) continue;
    const dt = i > 0 ? Math.min(t[i]! - t[i - 1]!, 30) : 0;
    sum += v * dt;
    w += dt;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (mn === Infinity) return { avg: null, min: null, max: null };
  return { avg: w > 0 ? sum / w : mn, min: mn, max: mx };
}

/** Average of the cadence stream, unless implausible for the sport (steps/min on foot, rpm on the bike). */
function streamCadence(b: BuiltStreams, footSport: boolean, isRide: boolean): number | null {
  const avg = nanStats(b.cadence, b.t).avg;
  if (avg === null) return null;
  const [lo, hi] = footSport ? [60, 250] : isRide ? [20, 150] : [0, Infinity];
  return avg >= lo && avg <= hi ? avg : null;
}

/**
 * Recompute everything derived for one workout of the athlete (streams, metrics, splits, best efforts, polyline, HR
 * histogram). Ids of other athletes' workouts are ignored.
 */
export function deriveWorkout(db: Db, cache: DeriveCache, athleteId: number, id: number): void {
  const w = get<WorkoutRow>(
    db,
    `SELECT id, athlete_id, sport, start_ts, end_ts, duration_s, source_name, indoor, meta, stats FROM workouts
     WHERE id = ? AND athlete_id = ?`,
    [id, athleteId],
  );
  if (!w) return;
  const aid = w.athlete_id;
  const stats = json<WorkoutStatistic[]>(w.stats, []);
  const meta = json<Record<string, string>>(w.meta, {});
  const summary = summarizeStats(w.sport, stats);
  const elapsed = Math.max(0, w.end_ts - w.start_ts);
  const src = cache.sourceId(w.source_name);
  const from = w.start_ts - 15;
  const to = w.end_ts + 15;

  // --- inputs ---
  const tracks: Track[] = [];
  for (const r of all<{ data: Uint8Array | null }>(
    db,
    'SELECT data FROM workout_routes WHERE workout_id = ? AND data IS NOT NULL ORDER BY start_ts',
    [id],
  )) {
    try {
      tracks.push(decodeTrack(r.data!));
    } catch {
      /* corrupt blob: ignore */
    }
  }
  const track = tracks.length ? mergeTracks(tracks) : null;
  const events = all<{ type: string; ts: number }>(
    db,
    'SELECT type, ts FROM workout_events WHERE workout_id = ? ORDER BY idx',
    [id],
  );
  const pauses = pausedIntervals(events, w.end_ts);
  // Sensor data recorded by the device itself (FIT files) beats Apple Health records of the same time span.
  const device = loadSensorSamples(db, id);
  const isRide = w.sport === 'ride' || w.sport === 'handcycle';
  const footSport = ['run', 'walk', 'hike', 'track_and_field'].includes(w.sport);
  const distType = DISTANCE_TYPE_BY_SPORT[w.sport];
  const hrRows = device ? [] : loadRecords(db, aid, cache.typeId(Q('HeartRate')), from, to, src);
  const powerRows = device
    ? []
    : loadRecords(db, aid, cache.typeId(Q(isRide ? 'CyclingPower' : 'RunningPower')), from, to, src);
  const cadRows =
    isRide && !device ? loadRecords(db, aid, cache.typeId(Q('CyclingCadence')), from, to, src) : [];
  const stepRows =
    footSport && !device ? loadRecords(db, aid, cache.typeId(Q('StepCount')), from - 60, to, src) : [];
  const distRows =
    distType && sportInfo(w.sport).distance && !device
      ? loadRecords(db, aid, cache.typeId(distType), from - 60, to, src)
      : [];

  const built = buildStreams({
    sport: w.sport,
    startTs: w.start_ts,
    endTs: w.end_ts,
    track,
    hr: device ? seriesOf(device, 'hr') : toSamples(hrRows),
    power: device ? seriesOf(device, 'power') : toSamples(powerRows),
    cadence: device ? seriesOf(device, 'cadence') : toSamples(cadRows),
    steps: toIntervals(stepRows.filter((r) => r.end_ts > w.start_ts - 5 && r.start_ts < w.end_ts + 5)),
    distance: device
      ? distanceIntervals(device)
      : toIntervals(distRows.filter((r) => r.end_ts > w.start_ts && r.start_ts < w.end_ts + 5)),
    appleDistanceM: summary.distanceM,
    pauses,
  });

  // --- metrics ---
  let distance = summary.distanceM;
  let movingS: number | null = null;
  let maxSpeed: number | null = null;
  let gain: number | null = null;
  let loss: number | null = null;
  const gainMeta = parseQuantityString(meta.HKElevationAscended);
  const lossMeta = parseQuantityString(meta.HKElevationDescended);
  let hrAvg = summary.avgHr;
  let hrMin = summary.minHr;
  let hrMax = summary.maxHr;
  let cadence = summary.avgCadence;
  let powerAvg = summary.avgPower;
  let powerMax = summary.maxPower;
  let hist: Float32Array | null = null;
  let polyline: string | null = null;
  let bbox: [number, number, number, number] | null = null;
  let startLL: [number, number] | null = null;
  let endLL: [number, number] | null = null;
  let stepCount = summary.stepCount;
  let swimStrokes = summary.swimStrokes;
  let energy = summary.energyKcal;

  if (built) {
    const n = built.t.length;
    if (built.dist) {
      const streamDist = built.dist[n - 1]!;
      if (distance === null && streamDist > 0) distance = streamDist;
    }
    if (built.dist || built.gps) {
      movingS = movingTime(built.t, built.moving);
      if (built.speed) maxSpeed = robustMaxSpeed(built.speed, built.moving, maxPlausibleSpeed(w.sport));
    }
    if (built.ele) {
      const gl = elevationGainLoss(built.ele, 2, 5, built.breaks);
      gain = gl.gain;
      loss = gl.loss;
    }
    const hs = nanStats(built.hr, built.t);
    if (hrAvg === null) hrAvg = hs.avg;
    if (hrMin === null) hrMin = hs.min;
    if (hrMax === null) hrMax = hs.max;
    // Only trust the time-in-zone histogram when the HR stream covers most of the workout (Apple samples every
    // ~5 s during workouts; sparse background samples fall back to TRIMP from the average).
    if (built.hr) {
      const h = hrHistogram(built.t, built.hr);
      const covered = h ? h.reduce((a, b) => a + b, 0) : 0;
      if (h && covered >= 0.5 * Math.max(1, built.t[n - 1]! - built.t[0]!)) hist = h;
    }
    const ps = nanStats(built.power, built.t);
    if (powerAvg === null) powerAvg = ps.avg;
    if (powerMax === null) powerMax = ps.max;
    if (built.lat && built.lon) {
      // one encoded polyline per part of the track (a jump across a pause is not drawn)
      const parts: LatLon[][] = trackParts(n, built.breaks).map(([a, b]) => {
        const la = built.lat!.subarray(a, b);
        const lo = built.lon!.subarray(a, b);
        return simplifyIndices(la, lo, 5).map((i): LatLon => [la[i]!, lo[i]!]);
      });
      polyline = encodePolylineParts(parts) || null;
      bbox = bounds(built.lat, built.lon);
      startLL = [built.lat[0]!, built.lon[0]!];
      endLL = [built.lat[n - 1]!, built.lon[n - 1]!];
    }
  }
  // Step records only stand in for Apple's step statistic when they cover most of the workout.
  if (stepCount === null && stepRows.length) {
    let covered = 0;
    for (const r of stepRows)
      covered += Math.max(0, Math.min(r.end_ts, w.end_ts) - Math.max(r.start_ts, w.start_ts));
    if (covered >= 0.5 * elapsed) stepCount = sumOf(stepRows, w.start_ts, w.end_ts);
  }
  if (swimStrokes === null && w.sport === 'swim') {
    const rows = loadRecords(db, aid, cache.typeId(Q('SwimmingStrokeCount')), from, to, src);
    swimStrokes = sumOf(rows, w.start_ts - 5, w.end_ts + 5);
  }
  if (energy === null) {
    const rows = loadRecords(db, aid, cache.typeId(Q('ActiveEnergyBurned')), from, to, src);
    energy = sumOf(rows, w.start_ts - 5, w.end_ts + 5);
  }
  if (movingS !== null && w.duration_s > 0) movingS = Math.min(movingS, Math.max(w.duration_s, elapsed));
  if (movingS === null || movingS <= 0) movingS = w.duration_s > 0 ? w.duration_s : elapsed;
  if (cadence === null && footSport && stepCount && movingS > 0) cadence = stepCount / (movingS / 60);
  else if (cadence === null && built?.cadence) cadence = streamCadence(built, footSport, isRide);
  const avgSpeed = distance && movingS > 0 ? distance / movingS : null;
  if (gainMeta && gainMeta.unit === 'm') gain = gainMeta.value;
  if (lossMeta && lossMeta.unit === 'm') loss = lossMeta.value;

  // --- splits & best efforts ---
  const splitRows: { unit: string; rows: ReturnType<typeof computeSplits> }[] = [];
  let efforts: ReturnType<typeof bestEfforts> = [];
  if (built?.dist && distance && distance >= 100) {
    const opts = { ele: built.ele, hr: built.hr, moving: built.moving };
    splitRows.push({ unit: 'km', rows: computeSplits(built.t, built.dist, 1000, opts) });
    splitRows.push({ unit: 'mi', rows: computeSplits(built.t, built.dist, M_PER_MI, opts) });
    const defs = (BEST_EFFORT_SPORTS as readonly string[]).includes(w.sport)
      ? BEST_EFFORTS[w.sport]
      : undefined;
    if (defs && (built.gps || w.sport === 'swim')) efforts = bestEfforts(built.t, built.dist, defs, w.sport);
  }

  // --- write ---
  if (built && built.t.length >= 2) {
    const dto = toDto(built);
    run(
      db,
      `INSERT INTO workout_streams (workout_id, version, points, data) VALUES (?, ?, ?, ?)
       ON CONFLICT (workout_id) DO UPDATE SET version = excluded.version, points = excluded.points, data = excluded.data`,
      [id, STREAMS_VERSION, built.t.length, gzipJson(dto)],
    );
  } else run(db, 'DELETE FROM workout_streams WHERE workout_id = ?', [id]);

  run(db, 'DELETE FROM workout_splits WHERE workout_id = ?', [id]);
  const insSplit = prepare(
    db,
    `INSERT INTO workout_splits (workout_id, unit, idx, distance_m, elapsed_s, moving_s, elev_diff_m, avg_hr, avg_speed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const s of splitRows)
    for (const r of s.rows)
      insSplit.run(
        id,
        s.unit,
        r.idx,
        round(r.distanceM, 1),
        round(r.elapsedS, 1),
        round(r.movingS, 1),
        round(r.elevDiffM, 1),
        round(r.avgHr, 1),
        round(r.avgSpeed, 3) ?? 0,
      );

  run(db, 'DELETE FROM best_efforts WHERE workout_id = ?', [id]);
  const insEffort = prepare(
    db,
    `INSERT INTO best_efforts (athlete_id, workout_id, sport, effort, distance_m, elapsed_s, start_offset_s, start_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const e of efforts)
    insEffort.run(
      aid,
      id,
      w.sport,
      e.key,
      e.distanceM,
      round(e.elapsedS, 1)!,
      round(e.startOffsetS, 1)!,
      w.start_ts,
    );

  run(
    db,
    `UPDATE workouts SET
       moving_s = ?, distance_m = ?, energy_kcal = ?, elevation_gain_m = ?, elevation_loss_m = ?,
       avg_hr = ?, min_hr = ?, max_hr = ?, avg_speed = ?, max_speed = ?, avg_cadence = ?, avg_power = ?, max_power = ?,
       step_count = ?, swim_strokes = ?, has_route = ?, start_lat = ?, start_lon = ?, end_lat = ?, end_lon = ?,
       min_lat = ?, min_lon = ?, max_lat = ?, max_lon = ?, polyline = ?, hr_hist = ?, derived_version = ?, updated_at = unixepoch()
     WHERE id = ?`,
    [
      round(movingS, 1),
      round(distance, 1),
      round(energy, 1),
      round(gain, 1),
      round(loss, 1),
      round(hrAvg, 1),
      round(hrMin, 0),
      round(hrMax, 0),
      round(avgSpeed, 3),
      round(maxSpeed, 3),
      round(cadence, 1),
      round(powerAvg, 1),
      round(powerMax, 0),
      round(stepCount, 0),
      round(swimStrokes, 0),
      polyline ? 1 : 0,
      startLL?.[0] ?? null,
      startLL?.[1] ?? null,
      endLL?.[0] ?? null,
      endLL?.[1] ?? null,
      bbox?.[1] ?? null,
      bbox?.[0] ?? null,
      bbox?.[3] ?? null,
      bbox?.[2] ?? null,
      polyline,
      hist ? gzipFloat32(hist) : null,
      DERIVE_VERSION,
      id,
    ],
  );
  const places = computePlaces(startLL?.[0] ?? null, startLL?.[1] ?? null, endLL?.[0] ?? null, endLL?.[1] ?? null);
  // hard repetitions: pace for foot sports and swims, power on the bike (speed there mostly follows the terrain)
  let reps: number | null = null;
  if (built) {
    const signal = w.sport === 'ride' ? built.power : (built.speed ?? null);
    if (signal) {
      const moving = built.moving;
      reps = hardReps(built.t, Array.from(signal, (x, i) => (moving[i] ? x : null)));
    }
  }
  run(db, 'UPDATE workouts SET place = ?, place_end = ?, places_via = ?, countries = ?, hard_reps = ? WHERE id = ?', [
    places.place,
    places.placeEnd,
    placesColumn(placesAlong(polyline)),
    placesColumn(countriesAlong(polyline)),
    reps,
    id,
  ]);
}

export const workoutsStep: DeriveStep = {
  id: 'core.workouts',
  label: 'Workout streams, splits & best efforts',
  weight: 6,
  run(ctx) {
    const ids =
      ctx.workoutIds === 'all'
        ? all<{ id: number }>(ctx.db, 'SELECT id FROM workouts WHERE athlete_id = ? ORDER BY start_ts', [
            ctx.athleteId,
          ]).map((r) => r.id)
        : ctx.workoutIds;
    const cache = new DeriveCache(ctx.db);
    const BATCH = 25;
    for (let i = 0; i < ids.length; i += BATCH) {
      ctx.checkCancelled();
      const slice = ids.slice(i, i + BATCH);
      tx(ctx.db, () => {
        for (const id of slice) deriveWorkout(ctx.db, cache, ctx.athleteId, id);
      });
      ctx.report(
        Math.min(1, (i + slice.length) / ids.length),
        `${Math.min(ids.length, i + slice.length)} / ${ids.length} workouts`,
      );
    }
  },
};
