import { metricCategory, type HealthCategory } from '@cadence/shared';
import type { ChartTheme } from '@/components/charts/theme';

/**
 * Fixed chart color per health measure (palette slots, never assigned by rank), so a measure keeps its color on every
 * page: heart red, HRV violet, respiration aqua, fitness blue, temperature yellow, body fat magenta, lean mass green.
 */
export type MeasureKey =
  | 'heartRate'
  | 'restingHr'
  | 'walkingHr'
  | 'hrv'
  | 'vo2max'
  | 'recovery'
  | 'respiratory'
  | 'spo2'
  | 'wristTemp'
  | 'weight'
  | 'bmi'
  | 'bodyFat'
  | 'lean'
  | 'height'
  | 'systolic'
  | 'diastolic'
  | 'generic';

const SLOT: Record<MeasureKey, number> = {
  heartRate: 8,
  restingHr: 8,
  walkingHr: 1,
  hrv: 7,
  vo2max: 2,
  recovery: 6,
  respiratory: 3,
  spo2: 2,
  wristTemp: 4,
  weight: 2,
  bmi: 7,
  bodyFat: 5,
  lean: 6,
  height: 2,
  systolic: 8,
  diastolic: 2,
  generic: 2,
};

export function measureColor(theme: ChartTheme, key: MeasureKey): string {
  return theme.series[SLOT[key] - 1]!;
}

const BY_IDENTIFIER: Record<string, MeasureKey> = {
  HKQuantityTypeIdentifierHeartRate: 'heartRate',
  HKQuantityTypeIdentifierRestingHeartRate: 'restingHr',
  HKQuantityTypeIdentifierWalkingHeartRateAverage: 'walkingHr',
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: 'hrv',
  HKQuantityTypeIdentifierVO2Max: 'vo2max',
  HKQuantityTypeIdentifierHeartRateRecoveryOneMinute: 'recovery',
  HKQuantityTypeIdentifierRespiratoryRate: 'respiratory',
  HKQuantityTypeIdentifierOxygenSaturation: 'spo2',
  HKQuantityTypeIdentifierAppleSleepingWristTemperature: 'wristTemp',
  HKQuantityTypeIdentifierBodyMass: 'weight',
  HKQuantityTypeIdentifierBodyMassIndex: 'bmi',
  HKQuantityTypeIdentifierBodyFatPercentage: 'bodyFat',
  HKQuantityTypeIdentifierLeanBodyMass: 'lean',
  HKQuantityTypeIdentifierBloodPressureSystolic: 'systolic',
  HKQuantityTypeIdentifierBloodPressureDiastolic: 'diastolic',
};

/** Palette slot per category for everything the catalogue has no dedicated measure color for. */
const BY_CATEGORY: Partial<Record<HealthCategory, number>> = {
  activity: 1,
  heart: 8,
  respiratory: 3,
  vitals: 4,
  body: 2,
  sleep: 2,
  mobility: 6,
  hearing: 7,
  nutrition: 6,
  mindfulness: 5,
  cycle: 5,
  symptoms: 8,
};

/** Fixed color of a record type: its measure color when it has one, otherwise by category. */
export function identifierColor(theme: ChartTheme, identifier: string): string {
  const key = BY_IDENTIFIER[identifier];
  if (key) return measureColor(theme, key);
  const slot = BY_CATEGORY[metricCategory(identifier)] ?? 2;
  return theme.series[slot - 1]!;
}

/** Palette slot (1..8) from a hash of the name. */
function hashSlot(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return (h % 8) + 1;
}

/**
 * Stable color slot (1..8) per name, so a source keeps its color across charts; collisions inside one set of names are
 * resolved by moving on to the next free slot (names given in rank order).
 */
export function assignSlots(names: string[]): Map<string, number> {
  const used = new Set<number>();
  const out = new Map<string, number>();
  for (const name of names) {
    let slot = hashSlot(name);
    for (let tries = 0; tries < 8 && used.has(slot); tries++) slot = (slot % 8) + 1;
    used.add(slot);
    out.set(name, slot);
  }
  return out;
}

/**
 * Category values of the catalogue in a fixed order, the values of one type next to each other (ordinal scales from
 * low to high): the stack and legend order of category charts, and — by position — the color of each value.
 */
const CATEGORY_VALUE_ORDER = [
  // stand hours
  'Stood',
  'Idle',
  // sessions without a value (mindfulness …)
  'NotApplicable',
  // menstrual flow
  'Unspecified',
  'None',
  'Light',
  'Medium',
  'Heavy',
  // symptom severity
  'SeverityMild',
  'SeverityModerate',
  'SeveritySevere',
  'NotPresent',
  'Present',
  // test results
  'Negative',
  'Positive',
  'Indeterminate',
  // cervical mucus
  'Dry',
  'Sticky',
  'Creamy',
  'Watery',
  'EggWhite',
];

/** Fixed order of category values (stacks, legends, tables): the catalogue order, then unknown values alphabetically. */
export function compareCategoryValues(a: string, b: string): number {
  const ia = CATEGORY_VALUE_ORDER.indexOf(a);
  const ib = CATEGORY_VALUE_ORDER.indexOf(b);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0 || ib >= 0) return ia >= 0 ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Palette slot (1..8) per category value, by identity and never by rank: a known value by its place in the fixed order
 * (so it keeps its color whatever else the range holds), others by a hash of the name; a taken slot moves on to the next
 * free one.
 */
export function categorySlots(values: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Set<number>();
  const take = (value: string, slot: number) => {
    for (let tries = 0; tries < 8 && used.has(slot); tries++) slot = (slot % 8) + 1;
    used.add(slot);
    out.set(value, slot);
  };
  const sorted = [...new Set(values)].sort(compareCategoryValues);
  for (const v of sorted) {
    const i = CATEGORY_VALUE_ORDER.indexOf(v);
    if (i >= 0) take(v, (i % 8) + 1);
  }
  for (const v of sorted) if (!out.has(v)) take(v, hashSlot(v));
  return out;
}
