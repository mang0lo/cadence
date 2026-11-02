import { normalizeUnit } from '@cadence/shared';
import type { WorkoutStatistic } from '@cadence/shared';

/**
 * HealthKit vocabulary: record kinds, aggregation semantics, category values, units in metadata strings,
 * workout event names and workout statistics → workout columns.
 */

export type RecordKind = 'quantity' | 'category' | 'other';
export type Aggregation = 'sum' | 'avg' | 'duration';

export const HR_TYPE = 'HKQuantityTypeIdentifierHeartRate';
export const STEP_TYPE = 'HKQuantityTypeIdentifierStepCount';
export const SLEEP_TYPE = 'HKCategoryTypeIdentifierSleepAnalysis';

export function recordKind(identifier: string): RecordKind {
  if (identifier.startsWith('HKQuantityTypeIdentifier')) return 'quantity';
  if (identifier.startsWith('HKCategoryTypeIdentifier')) return 'category';
  return 'other';
}

/** Quantity types whose samples add up (daily total = deduplicated sum). Everything else is averaged. */
const CUMULATIVE = new Set(
  [
    'StepCount',
    'DistanceWalkingRunning',
    'DistanceCycling',
    'DistanceSwimming',
    'DistanceWheelchair',
    'DistanceDownhillSnowSports',
    'DistanceRowing',
    'DistancePaddleSports',
    'DistanceCrossCountrySkiing',
    'DistanceSkatingSports',
    'ActiveEnergyBurned',
    'BasalEnergyBurned',
    'FlightsClimbed',
    'AppleExerciseTime',
    'AppleStandTime',
    'AppleMoveTime',
    'SwimmingStrokeCount',
    'PushCount',
    'TimeInDaylight',
    'NumberOfTimesFallen',
    'NikeFuel',
    'InhalerUsage',
    'NumberOfAlcoholicBeverages',
  ].map((s) => `HKQuantityTypeIdentifier${s}`),
);

export function isCumulative(identifier: string): boolean {
  if (CUMULATIVE.has(identifier)) return true;
  // Every nutrition type (DietaryEnergyConsumed, DietaryProtein, DietaryWater, DietaryCaffeine, …) is a sum.
  return identifier.startsWith('HKQuantityTypeIdentifierDietary');
}

export function aggregationOf(identifier: string, kind: RecordKind): Aggregation {
  if (kind === 'category') return 'duration';
  return isCumulative(identifier) ? 'sum' : 'avg';
}

/**
 * `HKCategoryValueSleepAnalysisAsleepCore` → `AsleepCore`, `HKCategoryValueAppleStandHourStood` → `Stood`,
 * `HKCategoryValueNotApplicable` → `NotApplicable`, `HKCategoryValueSeverityMild` → `SeverityMild`.
 */
export function categoryText(type: string, value: string): string {
  if (!value.startsWith('HKCategoryValue')) return value;
  let v = value.slice('HKCategoryValue'.length);
  const specific = type.startsWith('HKCategoryTypeIdentifier')
    ? type.slice('HKCategoryTypeIdentifier'.length)
    : '';
  if (specific && v.startsWith(specific) && v.length > specific.length) v = v.slice(specific.length);
  return v || value;
}

/** Sleep categories are attributed to the local day on which they END (the night belongs to the morning). */
export function assignByEnd(identifier: string): boolean {
  return identifier === SLEEP_TYPE;
}

/** `HKWorkoutEventTypePauseOrResumeRequest` → `pause_or_resume_request`. */
export function workoutEventType(raw: string): string {
  const s = raw.replace(/^HKWorkoutEventType/, '');
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase() || raw;
}

/** Duration value + unit → seconds (rounded to ms: "105.5667 min" must not become 6334.0019999). */
export function toSeconds(value: number, unit: string | null | undefined): number {
  return Math.round(toSecondsRaw(value, unit) * 1000) / 1000;
}

function toSecondsRaw(value: number, unit: string | null | undefined): number {
  switch (unit) {
    case 'ms':
      return value / 1000;
    case 's':
    case 'sec':
      return value;
    case 'min':
      return value * 60;
    case 'hr':
    case 'h':
      return value * 3600;
    case 'd':
    case 'day':
      return value * 86400;
    default:
      return value * 60; // Apple's default durationUnit is minutes
  }
}

/** Parse a number from an attribute; null for empty / non-numeric. */
export function num(v: string | null | undefined): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "4500 cm" → {value: 45, unit: 'm'}, "50 degF" → {value: 10, unit: 'degC'}, "10.5 kcal/hr·kg" kept as is. */
export function parseQuantityString(
  s: string | null | undefined,
): { value: number; unit: string | null } | null {
  if (!s) return null;
  const m = /^\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*(.*?)\s*$/.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  return normalizeUnit(v, m[2] || null);
}

/** Apple stores weather humidity as "8000 %" for 80 %. */
export function parseHumidity(s: string | null | undefined): number | null {
  const q = parseQuantityString(s);
  if (!q) return null;
  let v = q.value;
  if (v > 100) v /= 100;
  return v >= 0 && v <= 100 ? v : null;
}

export function parseBool(s: string | null | undefined): boolean | null {
  if (s === undefined || s === null || s === '') return null;
  const v = s.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  const n = Number(v);
  return Number.isFinite(n) ? n !== 0 : null;
}

/** Distance quantity type that Apple uses for a sport. */
export const DISTANCE_TYPE_BY_SPORT: Record<string, string> = {
  run: 'HKQuantityTypeIdentifierDistanceWalkingRunning',
  walk: 'HKQuantityTypeIdentifierDistanceWalkingRunning',
  hike: 'HKQuantityTypeIdentifierDistanceWalkingRunning',
  track_and_field: 'HKQuantityTypeIdentifierDistanceWalkingRunning',
  ride: 'HKQuantityTypeIdentifierDistanceCycling',
  handcycle: 'HKQuantityTypeIdentifierDistanceCycling',
  swim: 'HKQuantityTypeIdentifierDistanceSwimming',
  wheelchair: 'HKQuantityTypeIdentifierDistanceWheelchair',
  alpine_ski: 'HKQuantityTypeIdentifierDistanceDownhillSnowSports',
  snowboard: 'HKQuantityTypeIdentifierDistanceDownhillSnowSports',
  nordic_ski: 'HKQuantityTypeIdentifierDistanceCrossCountrySkiing',
  row: 'HKQuantityTypeIdentifierDistanceRowing',
  paddle: 'HKQuantityTypeIdentifierDistancePaddleSports',
  skate: 'HKQuantityTypeIdentifierDistanceSkatingSports',
};

export const DISTANCE_TYPES = new Set(Object.values(DISTANCE_TYPE_BY_SPORT));

/** Workout columns that can be filled from WorkoutStatistics / legacy attributes. */
export interface StatSummary {
  distanceM: number | null;
  energyKcal: number | null;
  avgHr: number | null;
  minHr: number | null;
  maxHr: number | null;
  stepCount: number | null;
  avgPower: number | null;
  maxPower: number | null;
  avgCadence: number | null;
  swimStrokes: number | null;
  avgSpeed: number | null;
}

export function summarizeStats(sport: string, stats: WorkoutStatistic[]): StatSummary {
  const by = new Map(stats.map((s) => [s.type, s]));
  const pick = (t: string) => by.get(`HKQuantityTypeIdentifier${t}`);
  let distance: number | null = null;
  const own = DISTANCE_TYPE_BY_SPORT[sport];
  if (own && by.get(own)?.sum != null) distance = by.get(own)!.sum;
  else if (sport === 'multisport') {
    // swim + bike + run legs add up
    for (const s of stats)
      if (DISTANCE_TYPES.has(s.type) && s.sum != null) distance = (distance ?? 0) + s.sum;
  } else {
    for (const s of stats)
      if (DISTANCE_TYPES.has(s.type) && s.sum != null) distance = Math.max(distance ?? 0, s.sum);
  }
  const hr = pick('HeartRate');
  const power =
    sport === 'ride'
      ? (pick('CyclingPower') ?? pick('RunningPower'))
      : (pick('RunningPower') ?? pick('CyclingPower'));
  const cadence = pick('CyclingCadence');
  const speed = pick('RunningSpeed') ?? pick('CyclingSpeed');
  return {
    distanceM: distance,
    energyKcal: pick('ActiveEnergyBurned')?.sum ?? null,
    avgHr: hr?.average ?? null,
    minHr: hr?.minimum ?? null,
    maxHr: hr?.maximum ?? null,
    stepCount: pick('StepCount')?.sum ?? null,
    avgPower: power?.average ?? null,
    maxPower: power?.maximum ?? null,
    avgCadence: cadence?.average ?? null,
    swimStrokes: pick('SwimmingStrokeCount')?.sum ?? null,
    avgSpeed: speed?.average ?? null,
  };
}
