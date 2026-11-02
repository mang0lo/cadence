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

/**
 * Stable color slot (1..8) per name, so a source keeps its color across charts; collisions inside one set of names are
 * resolved by moving on to the next free slot (names given in rank order).
 */
export function assignSlots(names: string[]): Map<string, number> {
  const used = new Set<number>();
  const out = new Map<string, number>();
  for (const name of names) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    let slot = (h % 8) + 1;
    for (let tries = 0; tries < 8 && used.has(slot); tries++) slot = (slot % 8) + 1;
    used.add(slot);
    out.set(name, slot);
  }
  return out;
}
