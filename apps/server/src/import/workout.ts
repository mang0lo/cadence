import { canonicalUnit, normalizeUnit, sportFromActivityType, type WorkoutStatistic } from '@cadence/shared';
import { isValidTimeZone, tzOffsetMinutes } from '../lib/tz';
import { parseAppleDate, parseIsoTime } from './dates';
import {
  DISTANCE_TYPE_BY_SPORT,
  num,
  parseBool,
  parseHumidity,
  parseQuantityString,
  summarizeStats,
  toSeconds,
  workoutEventType,
  type StatSummary,
} from './hk';
import { metadataOf, type XmlNode } from './parser';
import type { Track } from './track';
import type { XmlAttrs } from './xml';

export interface ParsedEvent {
  type: string;
  ts: number;
  durationS: number | null;
  meta: Record<string, string> | null;
}

export interface ParsedActivity {
  activityType: string;
  sport: string;
  startTs: number;
  endTs: number;
  durationS: number | null;
  stats: WorkoutStatistic[];
  meta: Record<string, string>;
  events: ParsedEvent[];
}

export interface ParsedWorkout {
  extKey: string;
  activityType: string;
  sport: string;
  startTs: number;
  endTs: number;
  tzMin: number;
  timezone: string | null;
  durationS: number;
  sourceName: string | null;
  sourceVersion: string | null;
  deviceRaw: string | null;
  meta: Record<string, string>;
  stats: WorkoutStatistic[];
  events: ParsedEvent[];
  activities: ParsedActivity[];
  routeFiles: string[];
  inlineTrack: Track | null;
  indoor: boolean;
  temperatureC: number | null;
  humidityPct: number | null;
  elevationGainM: number | null;
  elevationLossM: number | null;
  lapLengthM: number | null;
  summary: StatSummary;
}

function parseStat(a: XmlAttrs): WorkoutStatistic | null {
  const type = a.type;
  if (!type) return null;
  const unit = a.unit ?? null;
  const conv = (v: string | undefined) => {
    const x = num(v);
    return x === null ? null : normalizeUnit(x, unit).value;
  };
  return {
    type,
    sum: conv(a.sum),
    average: conv(a.average),
    minimum: conv(a.minimum),
    maximum: conv(a.maximum),
    unit: canonicalUnit(unit),
  };
}

function parseEvent(n: XmlNode): ParsedEvent | null {
  const ts = parseAppleDate(n.attrs.date ?? n.attrs.startDate)?.ts;
  if (ts === undefined) return null;
  const d = num(n.attrs.duration);
  const meta = metadataOf(n);
  return {
    type: workoutEventType(n.attrs.type ?? 'unknown'),
    ts,
    durationS: d === null ? null : toSeconds(d, n.attrs.durationUnit),
    meta: Object.keys(meta).length ? meta : null,
  };
}

function inlineLocations(route: XmlNode): Track | null {
  const pts = (route.children ?? []).filter((c) => c.name === 'Location');
  if (!pts.length) return null;
  const rows = pts
    .map((p) => {
      const a = p.attrs;
      const d = parseAppleDate(a.date)?.ts ?? parseIsoTime(a.date ?? '');
      return {
        t: d,
        lat: Number(a.latitude),
        lon: Number(a.longitude),
        ele: num(a.altitude) ?? NaN,
        speed: num(a.speed) ?? NaN,
        course: num(a.course) ?? NaN,
        hAcc: num(a.horizontalAccuracy) ?? NaN,
        vAcc: num(a.verticalAccuracy) ?? NaN,
      };
    })
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.lat) && Number.isFinite(r.lon))
    .sort((a, b) => a.t - b.t);
  if (rows.length < 2) return null;
  return {
    t: Float64Array.from(rows, (r) => r.t),
    lat: Float64Array.from(rows, (r) => r.lat),
    lon: Float64Array.from(rows, (r) => r.lon),
    ele: Float32Array.from(rows, (r) => r.ele),
    speed: Float32Array.from(rows, (r) => (r.speed >= 0 ? r.speed : NaN)),
    course: Float32Array.from(rows, (r) => (r.course >= 0 ? r.course : NaN)),
    hAcc: Float32Array.from(rows, (r) => r.hAcc),
    vAcc: Float32Array.from(rows, (r) => r.vAcc),
  };
}

/** Legacy (pre iOS 16) totals as attributes → synthetic statistics when no WorkoutStatistics cover them. */
function legacyStats(a: XmlAttrs, sport: string, stats: WorkoutStatistic[]): void {
  const has = (t: string) => stats.some((s) => s.type === t && s.sum !== null);
  const dist = num(a.totalDistance);
  if (dist !== null && dist > 0) {
    const type = DISTANCE_TYPE_BY_SPORT[sport] ?? 'HKQuantityTypeIdentifierDistanceWalkingRunning';
    if (!has(type)) {
      const unit = a.totalDistanceUnit ?? (dist < 500 ? 'km' : 'm');
      stats.push({
        type,
        sum: normalizeUnit(dist, unit).value,
        average: null,
        minimum: null,
        maximum: null,
        unit: 'm',
      });
    }
  }
  const energy = num(a.totalEnergyBurned);
  if (energy !== null && energy > 0 && !has('HKQuantityTypeIdentifierActiveEnergyBurned')) {
    stats.push({
      type: 'HKQuantityTypeIdentifierActiveEnergyBurned',
      sum: normalizeUnit(energy, a.totalEnergyBurnedUnit ?? 'kcal').value,
      average: null,
      minimum: null,
      maximum: null,
      unit: 'kcal',
    });
  }
  const strokes = num(a.totalSwimmingStrokeCount);
  if (strokes !== null && strokes > 0 && !has('HKQuantityTypeIdentifierSwimmingStrokeCount')) {
    stats.push({
      type: 'HKQuantityTypeIdentifierSwimmingStrokeCount',
      sum: strokes,
      average: null,
      minimum: null,
      maximum: null,
      unit: 'count',
    });
  }
  const flights = num(a.totalFlightsClimbed);
  if (flights !== null && flights > 0 && !has('HKQuantityTypeIdentifierFlightsClimbed')) {
    stats.push({
      type: 'HKQuantityTypeIdentifierFlightsClimbed',
      sum: flights,
      average: null,
      minimum: null,
      maximum: null,
      unit: 'count',
    });
  }
}

export function parseWorkout(node: XmlNode): ParsedWorkout | null {
  const a = node.attrs;
  const start = parseAppleDate(a.startDate);
  const end = parseAppleDate(a.endDate);
  if (!start || !end) return null;
  const activityType = a.workoutActivityType || 'HKWorkoutActivityTypeOther';
  const sport = sportFromActivityType(activityType);
  const meta = metadataOf(node);
  const stats: WorkoutStatistic[] = [];
  const events: ParsedEvent[] = [];
  const activities: ParsedActivity[] = [];
  const routeFiles: string[] = [];
  let inlineTrack: Track | null = null;

  for (const c of node.children ?? []) {
    switch (c.name) {
      case 'WorkoutStatistics': {
        const s = parseStat(c.attrs);
        if (s) stats.push(s);
        break;
      }
      case 'WorkoutEvent': {
        const e = parseEvent(c);
        if (e) events.push(e);
        break;
      }
      case 'WorkoutRoute':
        for (const r of c.children ?? [])
          if (r.name === 'FileReference' && r.attrs.path) routeFiles.push(r.attrs.path);
        inlineTrack ??= inlineLocations(c);
        break;
      case 'WorkoutActivity': {
        const ca = c.attrs;
        const s = parseAppleDate(ca.startDate)?.ts ?? start.ts;
        const e = parseAppleDate(ca.endDate)?.ts ?? end.ts;
        const amd = metadataOf(c);
        if (ca.uuid) amd.uuid ??= ca.uuid;
        const type = ca.workoutActivityType || ca.activityType || activityType;
        const d = num(ca.duration);
        activities.push({
          activityType: type,
          sport: sportFromActivityType(type),
          startTs: s,
          endTs: e,
          durationS: d === null ? null : toSeconds(d, ca.durationUnit),
          stats: (c.children ?? [])
            .filter((x) => x.name === 'WorkoutStatistics')
            .flatMap((x) => parseStat(x.attrs) ?? []),
          meta: amd,
          events: (c.children ?? [])
            .filter((x) => x.name === 'WorkoutEvent')
            .flatMap((x) => parseEvent(x) ?? []),
        });
        break;
      }
      default:
        break;
    }
  }
  legacyStats(a, sport, stats);
  // Events of sub-activities belong to the workout timeline as well (iOS 16+ puts laps/segments there).
  if (!events.length) for (const act of activities) events.push(...act.events);
  events.sort((x, y) => x.ts - y.ts);

  let tzMin = start.tzMin;
  let timezone: string | null = null;
  const zone = meta.HKTimeZone?.trim();
  if (isValidTimeZone(zone)) {
    timezone = zone;
    tzMin = tzOffsetMinutes(zone, start.ts) ?? tzMin;
  }
  const dur = num(a.duration);
  const durationS = dur !== null && dur > 0 ? toSeconds(dur, a.durationUnit) : end.ts - start.ts;
  const elev = parseQuantityString(meta.HKElevationAscended);
  const elevDown = parseQuantityString(meta.HKElevationDescended);
  const temp = parseQuantityString(meta.HKWeatherTemperature);
  const lap = parseQuantityString(meta.HKLapLength);
  const source = a.sourceName ?? null;

  return {
    extKey: `${activityType}|${start.ts}|${end.ts}|${source ?? ''}`,
    activityType,
    sport,
    startTs: start.ts,
    endTs: end.ts,
    tzMin,
    timezone,
    durationS,
    sourceName: source,
    sourceVersion: a.sourceVersion ?? null,
    deviceRaw: a.device ?? null,
    meta,
    stats,
    events,
    activities,
    routeFiles,
    inlineTrack,
    indoor: parseBool(meta.HKIndoorWorkout) ?? false,
    temperatureC: temp && (temp.unit === 'degC' || temp.unit === null) ? temp.value : null,
    humidityPct: parseHumidity(meta.HKWeatherHumidity),
    elevationGainM: elev && elev.unit === 'm' ? elev.value : null,
    elevationLossM: elevDown && elevDown.unit === 'm' ? elevDown.value : null,
    lapLengthM: lap && lap.unit === 'm' ? lap.value : null,
    summary: summarizeStats(sport, stats),
  };
}
