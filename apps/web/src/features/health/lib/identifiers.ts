import type { HealthMeta } from '@cadence/shared';

/**
 * HealthKit identifiers the health pages read by name, in one place. Metrics a watch can replace (COROS resting HR,
 * HRV, VO₂max, steps) are not read from here but from `useHeartMetrics()`, which follows the server's choice.
 */
export const HK = {
  heartRate: 'HKQuantityTypeIdentifierHeartRate',
  restingHr: 'HKQuantityTypeIdentifierRestingHeartRate',
  walkingHr: 'HKQuantityTypeIdentifierWalkingHeartRateAverage',
  hrv: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
  vo2max: 'HKQuantityTypeIdentifierVO2Max',
  recovery: 'HKQuantityTypeIdentifierHeartRateRecoveryOneMinute',
  respiratory: 'HKQuantityTypeIdentifierRespiratoryRate',
  spo2: 'HKQuantityTypeIdentifierOxygenSaturation',
  wristTemp: 'HKQuantityTypeIdentifierAppleSleepingWristTemperature',
  steps: 'HKQuantityTypeIdentifierStepCount',
  bodyMass: 'HKQuantityTypeIdentifierBodyMass',
  bmi: 'HKQuantityTypeIdentifierBodyMassIndex',
  bodyFat: 'HKQuantityTypeIdentifierBodyFatPercentage',
  leanMass: 'HKQuantityTypeIdentifierLeanBodyMass',
  height: 'HKQuantityTypeIdentifierHeight',
  systolic: 'HKQuantityTypeIdentifierBloodPressureSystolic',
} as const;

/** Apple's keys of the metrics the server may swap for the watch's own (`HealthMeta.metrics`, server core/sources.ts). */
export const APPLE_METRICS: HealthMeta['metrics'] = {
  restingHr: HK.restingHr,
  hrv: HK.hrv,
  vo2max: HK.vo2max,
  steps: HK.steps,
  heartRate: HK.heartRate,
};
