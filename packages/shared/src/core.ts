/**
 * Core API contract shared by server and web.
 *
 * Conventions (see docs/ARCHITECTURE.md):
 *  - Timestamps are unix seconds (UTC). `tzMin` is the local UTC offset in minutes at that moment,
 *    so local wall-clock time = new Date((ts + tzMin * 60) * 1000) read with UTC getters.
 *  - Calendar days are 'YYYY-MM-DD' strings in the athlete's local time.
 *  - All quantities are SI / canonical units: meters, seconds, m/s, kcal, °C, kg, bpm, watts.
 *    The UI converts to the user's preferred units for display only.
 */

export type Units = 'metric' | 'imperial';
export type Language = 'auto' | 'de' | 'en';
export type ThemePref = 'system' | 'light' | 'dark';
export type MapStylePref = 'streets' | 'outdoor' | 'satellite' | 'dark';
export type HrZoneMethod = 'maxhr' | 'hrr' | 'custom';

export interface PrivacyZone {
  lat: number;
  lon: number;
  radiusM: number;
  label?: string;
}

/** Persisted per-athlete preferences. `null` means "derive automatically from data". */
export interface AthleteSettings {
  units: Units;
  language: Language;
  theme: ThemePref;
  mapStyle: MapStylePref;
  /** Map tiles behind the route previews in feeds and lists (loaded from the map provider); off = the route only. */
  thumbnailMaps: boolean;
  /** 1 = Monday (default), 0 = Sunday. */
  weekStart: 0 | 1;
  maxHr: number | null;
  restingHr: number | null;
  hrZoneMethod: HrZoneMethod;
  /** Custom zone upper bounds in bpm for Z1..Z4 (Z5 is open ended). Used when hrZoneMethod = 'custom'. */
  hrZones: number[] | null;
  /** Cycling functional threshold power in watts. */
  ftp: number | null;
  /** Overrides for profile values that normally come from Apple Health's <Me> element. */
  sex: 'male' | 'female' | 'other' | null;
  birthDate: string | null;
  privacyZones: PrivacyZone[];
  /** The watch the athlete wears: decides which source wins when several record the same thing. */
  watch: WatchKind;
  /** Per data type override of `watch` ('auto' = follow the watch). */
  sources: DataSourcePrefs;
}

/** 'apple' = Apple Watch via Apple Health, 'coros' = COROS cloud sync, 'other' = FIT files from any other watch. */
export type WatchKind = 'apple' | 'coros' | 'other';
/** Source preference of one data type: 'device' = the watch's own files / cloud (COROS, FIT). */
export type SourcePref = 'auto' | 'apple' | 'device';

export interface DataSourcePrefs {
  /** Which copy of a workout recorded by several sources is shown (the other becomes a duplicate). */
  workouts: SourcePref;
  /** Resting heart rate, HRV and VO₂max (readiness, health overview, fitness). */
  heart: SourcePref;
}

/** GET /api/sources: which watch the athlete uses and what data exists, so pages show only what can have data. */
export interface DataSourcesInfo {
  watch: WatchKind;
  /** Data from an Apple Health export (records or workouts). */
  apple: { records: number; workouts: number };
  /** COROS connection (Watches page). */
  coros: { connected: boolean; lastSyncAt: number | null; lastError: string | null; workouts: number };
  /** Workouts imported from FIT files of other watches (COROS included). */
  fitWorkouts: number;
  /** Record types with at least one value (HealthKit identifiers and COROS… metrics). */
  metrics: string[];
  sleepNights: number;
  ecgCount: number;
  /** Apple activity rings. */
  rings: boolean;
}

export const DEFAULT_SETTINGS: AthleteSettings = {
  units: 'metric',
  language: 'auto',
  theme: 'system',
  mapStyle: 'streets',
  thumbnailMaps: true,
  weekStart: 1,
  maxHr: null,
  restingHr: null,
  hrZoneMethod: 'maxhr',
  hrZones: null,
  ftp: null,
  sex: null,
  birthDate: null,
  privacyZones: [],
  watch: 'apple',
  sources: { workouts: 'auto', heart: 'auto' },
};

/** Zone upper bounds as a fraction of max HR (maxhr) or heart-rate reserve (hrr), for Z1..Z4. */
export const HR_ZONE_FRACTIONS = [0.6, 0.7, 0.8, 0.9] as const;

export interface EffectiveHr {
  maxHr: number;
  restingHr: number;
  method: HrZoneMethod;
  /** Upper bounds in bpm for Z1..Z4; Z5 is everything above the last bound. */
  zoneBounds: number[];
  /** Where maxHr/restingHr came from. */
  maxHrSource: 'settings' | 'observed' | 'age' | 'default';
  restingHrSource: 'settings' | 'observed' | 'default';
}

export interface Athlete {
  id: number;
  name: string;
  birthDate: string | null;
  sex: 'male' | 'female' | 'other' | null;
  bloodType: string | null;
  skinType: string | null;
  age: number | null;
  hr: EffectiveHr;
  firstActivityTs: number | null;
  lastActivityTs: number | null;
}

export interface ServerStatus {
  ok: true;
  name: 'cadence';
  version: string;
  mode: 'dev' | 'desktop' | 'server';
  authRequired: boolean;
  /** True when POST /api/import/local is allowed (desktop mode). */
  localImport: boolean;
  counts: { workouts: number; records: number; recordTypes: number };
  lastImportAt: number | null;
}

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

export interface WorkoutSummary {
  id: number;
  name: string;
  sport: string;
  /** Raw HKWorkoutActivityType value, e.g. "HKWorkoutActivityTypeRunning". */
  activityType: string;
  startTs: number;
  endTs: number;
  tzMin: number;
  /** Active duration as recorded by Apple (pauses excluded). */
  durationS: number;
  /** endTs - startTs. */
  elapsedS: number;
  /** Time actually moving (derived from GPS speed), null without route. */
  movingS: number | null;
  distanceM: number | null;
  energyKcal: number | null;
  elevationGainM: number | null;
  avgHr: number | null;
  maxHr: number | null;
  /** Average speed in m/s (distance / moving time when available, else / duration). */
  avgSpeed: number | null;
  /** Relative effort (Banister-TRIMP based training load). */
  effort: number | null;
  effortEstimated: boolean;
  indoor: boolean;
  hasRoute: boolean;
  /** Google encoded polyline (precision 5) of the simplified route. */
  polyline: string | null;
  sourceName: string | null;
  notes: string | null;
  /** Town or city district of the start (offline GeoNames gazetteer, English/local name), null without GPS. */
  place?: string | null;
  /** Where a one-way activity ended, when that is another place (A → B); null for loops. */
  placeEnd?: string | null;
  /** True when the user hid the workout (only returned with includeHidden). */
  hidden?: boolean;
  /** Id of the workout this one duplicates (only returned with includeDuplicates). */
  duplicateOf?: number | null;
}

export interface WorkoutEvent {
  type: string; // 'pause' | 'resume' | 'lap' | 'marker' | 'segment' | 'motion_paused' | 'motion_resumed' | …
  ts: number;
  durationS: number | null;
  meta: Record<string, string> | null;
}

export interface WorkoutStatistic {
  type: string; // HKQuantityTypeIdentifier…
  sum: number | null;
  average: number | null;
  minimum: number | null;
  maximum: number | null;
  unit: string | null; // canonical unit
}

export interface SubActivity {
  idx: number;
  activityType: string;
  sport: string;
  startTs: number;
  endTs: number;
  durationS: number | null;
  stats: WorkoutStatistic[];
}

export interface Split {
  idx: number;
  /** Length of this split (1000 m / 1609.344 m except for the last partial split). */
  distanceM: number;
  elapsedS: number;
  movingS: number;
  elevDiffM: number | null;
  avgHr: number | null;
  avgSpeed: number;
}

export interface BestEffort {
  effort: string; // key from BEST_EFFORTS
  distanceM: number;
  elapsedS: number;
  startOffsetS: number;
  /** 1 = all-time best for this effort as of today, 2 = second best, 3 = third best; null otherwise. */
  rank: number | null;
}

export interface WorkoutDetail extends WorkoutSummary {
  timezone: string | null;
  minHr: number | null;
  maxSpeed: number | null;
  avgCadence: number | null;
  avgPower: number | null;
  maxPower: number | null;
  elevationLossM: number | null;
  stepCount: number | null;
  swimStrokes: number | null;
  lapLengthM: number | null;
  temperatureC: number | null;
  humidityPct: number | null;
  sourceVersion: string | null;
  device: string | null;
  /** [minLon, minLat, maxLon, maxLat] */
  bounds: [number, number, number, number] | null;
  startLatLng: [number, number] | null;
  endLatLng: [number, number] | null;
  /** Seconds spent in Z1..Z5. */
  hrZones: number[] | null;
  stats: WorkoutStatistic[];
  meta: Record<string, string>;
  events: WorkoutEvent[];
  activities: SubActivity[];
  splitsMetric: Split[];
  splitsImperial: Split[];
  bestEfforts: BestEffort[];
  duplicateOf: number | null;
}

/**
 * Columnar, index-aligned time series for one workout. `t` is seconds since workout start.
 * Arrays other than `t` are optional; missing samples are `null`.
 */
export interface WorkoutStreams {
  t: number[];
  lat?: number[];
  lon?: number[];
  ele?: (number | null)[];
  /** Cumulative distance in meters. */
  dist?: number[];
  /** Smoothed speed in m/s. */
  speed?: (number | null)[];
  hr?: (number | null)[];
  /** Running: steps per minute (both feet); cycling: rpm. */
  cadence?: (number | null)[];
  power?: (number | null)[];
  /** 1 while moving, 0 while stopped/paused (basis of moving time). */
  moving?: number[];
  /**
   * Indices where a new part of the GPS track starts: the position jumped across a pause (e.g. a train ride
   * while the workout was paused). Parts are drawn separately; distance and elevation are not counted across.
   */
  breaks?: number[];
}

/**
 * Separates the parts of an encoded route polyline (`WorkoutSummary.polyline`) whose track has breaks
 * (see `WorkoutStreams.breaks`). The polyline alphabet never contains a space.
 */
export const POLYLINE_PART_SEPARATOR = ' ';

/** The encoded parts of a (possibly multi-part) route polyline. */
export const polylineParts = (encoded: string): string[] =>
  encoded.split(POLYLINE_PART_SEPARATOR).filter((p) => p.length > 0);

export interface WorkoutListQuery {
  sport?: string; // comma separated list allowed
  from?: number; // unix seconds
  to?: number;
  q?: string; // name/notes search
  hasRoute?: boolean;
  sort?: 'start' | 'distance' | 'duration' | 'effort' | 'elevation';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  includeHidden?: boolean;
  /** Also list workouts flagged as duplicates of another workout (excluded by default). */
  includeDuplicates?: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface WorkoutPatch {
  name?: string;
  notes?: string | null;
  sport?: string;
  hidden?: boolean;
}

export interface SportCount {
  sport: string;
  count: number;
  distanceM: number;
  durationS: number;
}

// ---------------------------------------------------------------------------
// Health records / daily metrics
// ---------------------------------------------------------------------------

export interface RecordTypeInfo {
  id: number;
  identifier: string; // e.g. HKQuantityTypeIdentifierHeartRate
  kind: 'quantity' | 'category' | 'other';
  unit: string | null;
  /** 'sum' for cumulative types (steps, energy…), 'avg' for discrete types (heart rate, weight…). */
  aggregation: 'sum' | 'avg' | 'duration';
  count: number;
  firstTs: number | null;
  lastTs: number | null;
}

/**
 * One row of daily_metrics. For 'sum' metrics `value` is the (source-deduplicated) daily total;
 * for 'avg' metrics `value` is the mean with min/max; for category metrics `value` is minutes.
 */
export interface DailyMetric {
  day: string;
  value: number;
  min: number | null;
  max: number | null;
  n: number;
}

export interface HealthSample {
  startTs: number;
  endTs: number;
  tzMin: number;
  value: number | null;
  text: string | null;
  source: string | null;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export type ImportStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type ImportPhase = 'upload' | 'scan' | 'parse' | 'routes' | 'ecg' | 'derive' | 'finalize';

export interface ImportStats {
  bytesTotal: number;
  bytesProcessed: number;
  recordsSeen: number;
  recordsInserted: number;
  workoutsSeen: number;
  workoutsInserted: number;
  routesParsed: number;
  activitySummaries: number;
  correlations: number;
  ecgReadings: number;
  otherItems: number;
  recordTypes: number;
  exportDate: string | null;
  locale: string | null;
  /** Non-fatal problems (malformed elements, unreadable route files, …). */
  warnings: string[];
  /** Workouts derived (streams, splits, efforts) by this job. */
  workoutsDerived?: number;
  /** Seconds spent per phase, e.g. { parse: 12.3, routes: 2.1, derive: 8.4 }. */
  phaseSeconds?: Partial<Record<ImportPhase, number>>;
  /** What the import brought (import jobs that finished, see ImportSummary). */
  summary?: ImportSummary;
}

/** A new activity in an import summary (slim: summaries are kept with every job). */
export interface ImportSummaryWorkout {
  id: number;
  name: string;
  sport: string;
  startTs: number;
  tzMin: number;
  distanceM: number | null;
  movingS: number;
  place: string | null;
}

/**
 * Something a feature module found noteworthy in the new activities (a personal record, a trophy, new explorer
 * tiles …). The web module of `feature` renders it; `data` holds values in canonical units.
 */
export interface ImportHighlight {
  feature: string;
  kind: string;
  workoutId: number | null;
  /** The activity behind workoutId (added by the summary, for titles and links). */
  workout?: { id: number; name: string; sport: string; startTs: number; tzMin: number } | null;
  data: Record<string, string | number | boolean | null>;
}

/** "What's new" after an import: the new visible activities and their highlights. */
export interface ImportSummary {
  /** Visible new activities (no duplicates, not hidden). */
  count: number;
  /** True for the first import (everything is new, so records and tiles are not listed). */
  initial: boolean;
  /** Per sport, most activities first. */
  sports: { sport: string; count: number; distanceM: number; movingS: number }[];
  /** Local days of the oldest and newest new activity. */
  fromDay: string | null;
  toDay: string | null;
  /** The newest new activities (max 5). */
  latest: ImportSummaryWorkout[];
  highlights: ImportHighlight[];
}

export interface ImportJob {
  id: string;
  kind: 'import' | 'rederive';
  status: ImportStatus;
  phase: ImportPhase | null;
  /** 0..1 overall progress. */
  progress: number;
  message: string | null;
  sourceName: string | null;
  sizeBytes: number | null;
  stats: ImportStats;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Estimated seconds until the job finishes (running jobs only, null while unknown). */
  etaS?: number | null;
  /** Label of the current derive step while phase = 'derive'. */
  step?: string | null;
}

/** POST /api/import/local */
export interface LocalImportRequest {
  path: string;
}

/** POST /api/import/rederive (empty body = full rebuild of all derived data). */
export interface RederiveRequest {
  workoutIds?: number[];
  sinceDay?: string | null;
}

/** POST /api/import/reset – wipes every imported and derived row of the athlete. */
export interface ResetRequest {
  confirm: 'DELETE';
}

export interface ApiError {
  error: { code: string; message: string };
}
