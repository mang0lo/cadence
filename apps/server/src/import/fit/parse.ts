import { Decoder, Stream } from '@garmin/fitsdk';
import { DISTANCE_TYPE_BY_SPORT } from '../hk';
import { sportFromActivityType, type WorkoutStatistic } from '@cadence/shared';
import type { SensorSamples } from '../samples';
import type { Track } from '../track';

/**
 * FIT activity file (Garmin's binary format, written by COROS, Garmin, Wahoo, Suunto, Polar … watches and bike
 * computers) → the same shape the Apple Health importer produces: one workout, its GPS track and the device's
 * own sensor samples. Units come out canonical (m, s, m/s, kcal, bpm, W).
 * The device's temperature sensor is skipped: on a wrist it measures the body, not the weather.
 */
export interface FitActivity {
  /** Dedupe key: `fit:<serial or manufacturer>:<start ts>` (re-importing the same file is a no-op). */
  extKey: string;
  /** HKWorkoutActivityType… equivalent, so the sport catalogue and names work unchanged. */
  activityType: string;
  sport: string;
  startTs: number;
  endTs: number;
  tzMin: number | null;
  /** Timer time (moving, without pauses) in seconds. */
  durationS: number;
  indoor: boolean;
  manufacturer: string | null;
  product: string | null;
  softwareVersion: string | null;
  stats: WorkoutStatistic[];
  meta: Record<string, string>;
  events: { type: 'pause' | 'resume' | 'lap'; ts: number }[];
  lapLengthM: number | null;
  track: Track | null;
  samples: SensorSamples | null;
}

export class FitError extends Error {}

const FIT_EPOCH_S = 631065600;

/** FIT sport / sub sport → HKWorkoutActivityType suffix. */
function activityTypeOf(sport: string, sub: string): string {
  switch (sport) {
    case 'running':
      return sub === 'track' ? 'TrackAndField' : 'Running';
    case 'walking':
      return 'Walking';
    case 'hiking':
    case 'mountaineering':
    case 'snowshoeing':
      return 'Hiking';
    case 'cycling':
    case 'eBiking':
      return sub === 'handCycling' ? 'HandCycling' : 'Cycling';
    case 'swimming':
      return 'Swimming';
    case 'rowing':
      return 'Rowing';
    case 'paddling':
    case 'kayaking':
    case 'rafting':
    case 'standUpPaddleboarding':
      return 'PaddleSports';
    case 'sailing':
      return 'Sailing';
    case 'surfing':
    case 'windsurfing':
    case 'kitesurfing':
    case 'wakeboarding':
    case 'wakesurfing':
      return 'SurfingSports';
    case 'waterSkiing':
    case 'waterSport':
    case 'waterTubing':
    case 'boating':
      return 'WaterSports';
    case 'diving':
    case 'snorkeling':
    case 'poolApnea':
      return 'UnderwaterDiving';
    case 'alpineSkiing':
      return 'DownhillSkiing';
    case 'crossCountrySkiing':
      return 'CrossCountrySkiing';
    case 'snowboarding':
      return 'Snowboarding';
    case 'winterSport':
    case 'snowmobiling':
      return 'SnowSports';
    case 'inlineSkating':
    case 'iceSkating':
      return 'SkatingSports';
    case 'rockClimbing':
      return 'Climbing';
    case 'floorClimbing':
      return 'StairClimbing';
    case 'hiit':
      return 'HighIntensityIntervalTraining';
    case 'boxing':
      return 'Boxing';
    case 'mixedMartialArts':
      return 'MartialArts';
    case 'dance':
      return 'Dance';
    case 'jumpRope':
      return 'JumpRope';
    case 'meditation':
    case 'mobility':
      return sub === 'yoga' ? 'Yoga' : 'MindAndBody';
    case 'golf':
    case 'discGolf':
      return sport === 'golf' ? 'Golf' : 'DiscSports';
    case 'horsebackRiding':
      return 'EquestrianSports';
    case 'hunting':
      return 'Hunting';
    case 'fishing':
      return 'Fishing';
    case 'archery':
      return 'Archery';
    case 'basketball':
      return 'Basketball';
    case 'soccer':
      return 'Soccer';
    case 'tennis':
      return 'Tennis';
    case 'americanFootball':
      return 'AmericanFootball';
    case 'baseball':
      return 'Baseball';
    case 'cricket':
      return 'Cricket';
    case 'rugby':
      return 'Rugby';
    case 'hockey':
      return 'Hockey';
    case 'lacrosse':
      return 'Lacrosse';
    case 'volleyball':
      return 'Volleyball';
    case 'racket':
      return 'Racquetball';
    case 'wheelchairPushWalk':
      return 'WheelchairWalkPace';
    case 'wheelchairPushRun':
      return 'WheelchairRunPace';
    case 'multisport':
      return 'SwimBikeRun';
    case 'transition':
      return 'Transition';
    case 'videoGaming':
      return 'FitnessGaming';
    case 'training':
    case 'fitnessEquipment':
      switch (sub) {
        case 'strengthTraining':
          return 'TraditionalStrengthTraining';
        case 'cardioTraining':
          return 'MixedCardio';
        case 'yoga':
          return 'Yoga';
        case 'pilates':
          return 'Pilates';
        case 'elliptical':
          return 'Elliptical';
        case 'stairClimbing':
          return 'StairClimbing';
        case 'indoorRowing':
          return 'Rowing';
        case 'flexibilityTraining':
          return 'Flexibility';
        case 'hiit':
        case 'amrap':
        case 'emom':
        case 'tabata':
          return 'HighIntensityIntervalTraining';
        case 'treadmill':
        case 'indoorRunning':
          return 'Running';
        case 'indoorWalking':
          return 'Walking';
        case 'indoorCycling':
        case 'spin':
          return 'Cycling';
        case 'indoorClimbing':
        case 'bouldering':
          return 'Climbing';
        default:
          return 'Other';
      }
    default:
      return 'Other';
  }
}

const INDOOR_SUBSPORTS = new Set([
  'treadmill',
  'indoorCycling',
  'spin',
  'indoorRowing',
  'indoorRunning',
  'indoorWalking',
  'indoorSkiing',
  'indoorClimbing',
  'bouldering',
  'virtualActivity',
  'lapSwimming',
  'elliptical',
  'stairClimbing',
  'strengthTraining',
  'cardioTraining',
  'yoga',
  'pilates',
]);

/** Human readable manufacturer for source names ('coros' → 'COROS', 'garmin' → 'Garmin'). */
function manufacturerLabel(m: unknown): string | null {
  if (typeof m !== 'string' || !m || m === 'development') return null;
  const known: Record<string, string> = {
    coros: 'COROS',
    garmin: 'Garmin',
    wahooFitness: 'Wahoo',
    suunto: 'Suunto',
    polar: 'Polar',
    hammerhead: 'Hammerhead',
    zwift: 'Zwift',
    stryd: 'Stryd',
    bryton: 'Bryton',
    sigmasport: 'Sigma',
    amazfit: 'Amazfit',
    zeppHealth: 'Zepp',
    huawei: 'Huawei',
    apple: 'Apple',
  };
  return known[m] ?? m.charAt(0).toUpperCase() + m.slice(1);
}

type Mesg = Record<string, unknown>;

const tsOf = (v: unknown): number | null =>
  v instanceof Date ? v.getTime() / 1000 : typeof v === 'number' && v > 0 ? v + FIT_EPOCH_S : null;
const numOf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const semicircles = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v !== 0x7fffffff ? (v * 180) / 2 ** 31 : null;

function stat(
  type: string,
  unit: string | null,
  v: { sum?: number | null; average?: number | null; minimum?: number | null; maximum?: number | null },
): WorkoutStatistic | null {
  const s: WorkoutStatistic = {
    type: `HKQuantityTypeIdentifier${type}`,
    sum: v.sum ?? null,
    average: v.average ?? null,
    minimum: v.minimum ?? null,
    maximum: v.maximum ?? null,
    unit,
  };
  return s.sum === null && s.average === null && s.minimum === null && s.maximum === null ? null : s;
}

/** Parse one FIT activity file. Throws FitError when the file is not a readable FIT activity. */
export function parseFit(buf: Uint8Array): FitActivity {
  const stream = Stream.fromByteArray(Array.from(buf));
  if (!Decoder.isFIT(stream)) throw new FitError('Not a FIT file');
  const decoder = new Decoder(stream);
  const { messages, errors } = decoder.read({
    applyScaleAndOffset: true,
    expandSubFields: true,
    expandComponents: true,
    convertTypesToStrings: true,
    convertDateTimesToDates: true,
    mergeHeartRates: true,
  });
  const m = messages as unknown as Record<string, Mesg[] | undefined>;
  const fileId = m.fileIdMesgs?.[0] ?? {};
  if (fileId.type !== undefined && fileId.type !== 'activity')
    throw new FitError(`FIT file is not an activity (${String(fileId.type)})`);
  const sessions = m.sessionMesgs ?? [];
  const records = (m.recordMesgs ?? []).filter((r) => tsOf(r.timestamp) !== null);
  if (!sessions.length && !records.length)
    throw new FitError(
      errors.length ? `Unreadable FIT file: ${errors[0]!.message}` : 'FIT file without activity data',
    );

  // --- session (summary). Multisport files have one session per leg: the first one gives the sport. ---
  const session = sessions[0] ?? {};
  const multi = sessions.length > 1;
  const fitSport = multi ? 'multisport' : String(session.sport ?? m.sportMesgs?.[0]?.sport ?? 'generic');
  const subSport = multi ? 'generic' : String(session.subSport ?? m.sportMesgs?.[0]?.subSport ?? 'generic');
  const activityType = `HKWorkoutActivityType${activityTypeOf(fitSport, subSport)}`;
  const sport = sportFromActivityType(activityType);

  const firstRecTs = records.length ? tsOf(records[0]!.timestamp)! : null;
  const lastRecTs = records.length ? tsOf(records[records.length - 1]!.timestamp)! : null;
  const sessStart = sessions.map((s) => tsOf(s.startTime)).filter((x): x is number => x !== null);
  const startTs = Math.floor(sessStart.length ? Math.min(...sessStart) : (firstRecTs ?? 0));
  const sum = (k: string) => {
    let s = 0;
    let any = false;
    for (const x of sessions) {
      const v = numOf(x[k]);
      if (v !== null) {
        s += v;
        any = true;
      }
    }
    return any ? s : null;
  };
  const maxOf = (k: string) => {
    const v = sessions.map((x) => numOf(x[k])).filter((x): x is number => x !== null);
    return v.length ? Math.max(...v) : null;
  };
  const minOf = (k: string) => {
    const v = sessions.map((x) => numOf(x[k])).filter((x): x is number => x !== null && x > 0);
    return v.length ? Math.min(...v) : null;
  };
  /** Duration-weighted average over sessions. */
  const avgOf = (k: string) => {
    let s = 0;
    let w = 0;
    for (const x of sessions) {
      const v = numOf(x[k]);
      const d = numOf(x.totalTimerTime) ?? numOf(x.totalElapsedTime) ?? 1;
      if (v !== null && v > 0) {
        s += v * d;
        w += d;
      }
    }
    return w > 0 ? s / w : null;
  };
  const elapsed = sum('totalElapsedTime');
  const timer = sum('totalTimerTime');
  let endTs = Math.ceil(startTs + (elapsed ?? 0));
  if (lastRecTs !== null && lastRecTs > endTs) endTs = Math.ceil(lastRecTs);
  if (endTs <= startTs) endTs = startTs + Math.max(1, Math.round(timer ?? 1));
  if (!startTs) throw new FitError('FIT file without a start time');

  // --- time zone: the activity message's local timestamp minus its UTC timestamp ---
  let tzMin: number | null = null;
  const act = m.activityMesgs?.[0];
  if (act) {
    const utc = tsOf(act.timestamp);
    const local = numOf(act.localTimestamp);
    if (utc !== null && local !== null) {
      const off = Math.round((local + FIT_EPOCH_S - utc) / 60 / 15) * 15;
      if (Math.abs(off) <= 14 * 60) tzMin = off;
    }
  }

  // --- device ---
  const creator =
    (m.deviceInfoMesgs ?? []).find((d) => d.deviceIndex === 'creator' || d.deviceIndex === 0) ?? null;
  const manufacturer = manufacturerLabel(fileId.manufacturer ?? creator?.manufacturer);
  const productRaw = fileId.productName ?? creator?.productName ?? fileId.garminProduct ?? fileId.product;
  const product =
    typeof productRaw === 'string' && productRaw.trim()
      ? productRaw.trim()
      : typeof productRaw === 'number'
        ? `#${productRaw}`
        : null;
  const softwareVersion = numOf(creator?.softwareVersion)?.toString() ?? null;
  const serial = numOf(fileId.serialNumber);

  // --- samples ---
  const n = records.length;
  const t = new Float64Array(n);
  const lat = new Float64Array(n).fill(NaN);
  const lon = new Float64Array(n).fill(NaN);
  const ele = new Float32Array(n).fill(NaN);
  const speed = new Float32Array(n).fill(NaN);
  const hr = new Float64Array(n).fill(NaN);
  const power = new Float64Array(n).fill(NaN);
  const cadence = new Float64Array(n).fill(NaN);
  const dist = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const r = records[i]!;
    t[i] = tsOf(r.timestamp)!;
    const la = semicircles(r.positionLat);
    const lo = semicircles(r.positionLong);
    if (la !== null && lo !== null && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && (la !== 0 || lo !== 0)) {
      lat[i] = la;
      lon[i] = lo;
    }
    const alt = numOf(r.enhancedAltitude) ?? numOf(r.altitude);
    if (alt !== null && alt > -500 && alt < 9000) ele[i] = alt;
    const sp = numOf(r.enhancedSpeed) ?? numOf(r.speed);
    if (sp !== null && sp >= 0 && sp < 100) speed[i] = sp;
    const h = numOf(r.heartRate);
    if (h !== null && h >= 25 && h <= 250) hr[i] = h;
    const p = numOf(r.power);
    if (p !== null && p >= 0 && p < 3000) power[i] = p;
    const c = numOf(r.cadence);
    if (c !== null && c > 0 && c < 255) cadence[i] = c + (numOf(r.fractionalCadence) ?? 0);
    const d = numOf(r.distance);
    if (d !== null && d >= 0) dist[i] = d;
  }
  // Running cadence in FIT is strides (one foot) per minute: Cadence shows steps/min like Apple.
  const foot = ['run', 'walk', 'hike', 'track_and_field'].includes(sport);
  if (foot) {
    const vals = Array.from(cadence)
      .filter((x) => x === x)
      .sort((a, b) => a - b);
    const median = vals.length ? vals[vals.length >> 1]! : 0;
    if (median > 0 && median < 120) for (let i = 0; i < n; i++) cadence[i] = cadence[i]! * 2;
  }
  const any = (a: ArrayLike<number>) => {
    for (let i = 0; i < a.length; i++) if (a[i] === a[i]) return true;
    return false;
  };

  let track: Track | null = null;
  const gpsIdx: number[] = [];
  for (let i = 0; i < n; i++) if (lat[i] === lat[i]) gpsIdx.push(i);
  if (gpsIdx.length >= 2) {
    const pick32 = (a: Float32Array) => {
      const out = Float32Array.from(gpsIdx, (i) => a[i]!);
      return any(out) ? out : null;
    };
    track = {
      t: Float64Array.from(gpsIdx, (i) => t[i]!),
      lat: Float64Array.from(gpsIdx, (i) => lat[i]!),
      lon: Float64Array.from(gpsIdx, (i) => lon[i]!),
      ele: pick32(ele),
      speed: pick32(speed),
      course: null,
      hAcc: null,
      vAcc: null,
    };
  }
  const samples: SensorSamples | null =
    n && (any(hr) || any(power) || any(cadence) || any(dist))
      ? {
          t,
          hr: any(hr) ? hr : null,
          power: any(power) ? power : null,
          cadence: any(cadence) ? cadence : null,
          dist: any(dist) ? dist : null,
        }
      : null;

  // --- events: timer stop/start → pause/resume, laps ---
  const events: FitActivity['events'] = [];
  let paused = false;
  for (const e of m.eventMesgs ?? []) {
    if (e.event !== 'timer') continue;
    const ts = tsOf(e.timestamp);
    if (ts === null || ts <= startTs || ts >= endTs) continue;
    if ((e.eventType === 'stop' || e.eventType === 'stopAll') && !paused) {
      events.push({ type: 'pause', ts });
      paused = true;
    } else if (e.eventType === 'start' && paused) {
      events.push({ type: 'resume', ts });
      paused = false;
    }
  }
  const laps = m.lapMesgs ?? [];
  if (laps.length > 1)
    for (const l of laps.slice(1)) {
      const ts = tsOf(l.startTime);
      if (ts !== null && ts > startTs && ts < endTs) events.push({ type: 'lap', ts });
    }
  events.sort((a, b) => a.ts - b.ts);

  // --- statistics (WorkoutStatistic, as Apple's export has them) ---
  const stats: WorkoutStatistic[] = [];
  const push = (s: WorkoutStatistic | null) => s && stats.push(s);
  const distance = sum('totalDistance');
  const distType = DISTANCE_TYPE_BY_SPORT[sport];
  if (distance !== null && distance > 0 && distType)
    push(stat(distType.replace('HKQuantityTypeIdentifier', ''), 'm', { sum: distance }));
  const kcal = sum('totalCalories');
  if (kcal !== null && kcal > 0) push(stat('ActiveEnergyBurned', 'kcal', { sum: kcal }));
  push(
    stat('HeartRate', 'count/min', {
      average: avgOf('avgHeartRate'),
      minimum: minOf('minHeartRate'),
      maximum: maxOf('maxHeartRate'),
    }),
  );
  const isRide = sport === 'ride' || sport === 'handcycle';
  push(
    stat(isRide ? 'CyclingPower' : 'RunningPower', 'W', {
      average: avgOf('avgPower'),
      maximum: maxOf('maxPower'),
    }),
  );
  if (isRide) push(stat('CyclingCadence', 'count/min', { average: avgOf('avgCadence') }));
  if (sport === 'swim') {
    const strokes = sum('totalCycles');
    if (strokes) push(stat('SwimmingStrokeCount', 'count', { sum: strokes }));
  }

  const meta: Record<string, string> = {};
  const ascent = sum('totalAscent');
  const descent = sum('totalDescent');
  if (ascent !== null) meta.HKElevationAscended = `${ascent} m`;
  if (descent !== null) meta.HKElevationDescended = `${descent} m`;
  meta.FitSport = subSport !== 'generic' ? `${fitSport}/${subSport}` : fitSport;
  const tss = numOf(session.trainingStressScore);
  if (tss !== null) meta.FitTrainingStressScore = String(Math.round(tss * 10) / 10);
  const aerobic = numOf(session.totalTrainingEffect);
  if (aerobic !== null) meta.FitAerobicTrainingEffect = String(aerobic);
  const anaerobic = numOf(session.totalAnaerobicTrainingEffect);
  if (anaerobic !== null) meta.FitAnaerobicTrainingEffect = String(anaerobic);

  const pool = numOf(session.poolLength);

  const durationS = timer ?? elapsed ?? endTs - startTs;
  return {
    extKey: `fit:${serial ?? (manufacturer ?? 'device').toLowerCase()}:${startTs}`,
    activityType,
    sport,
    startTs,
    endTs,
    tzMin,
    durationS: Math.round(durationS * 1000) / 1000,
    indoor: INDOOR_SUBSPORTS.has(subSport) || (!track && fitSport === 'training'),
    manufacturer,
    product,
    softwareVersion,
    stats,
    meta,
    events,
    lapLengthM: sport === 'swim' && pool && pool > 0 ? pool : null,
    track,
    samples,
  };
}
