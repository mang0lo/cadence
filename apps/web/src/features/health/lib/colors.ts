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
