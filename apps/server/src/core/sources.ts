import type { AthleteSettings, SourcePref } from '@cadence/shared';
import { get, type Db } from '../db/db';
import { getSettings } from './settings';

/**
 * Which source wins when several record the same thing (Settings → "My watch" + per type overrides).
 *
 * COROS values are stored as their own metrics (COROSRestingHeartRate, COROSSleepHRV …) because they are not the
 * same measurement as Apple's (COROS' HRV is an overnight RMSSD, Apple's an SDNN of spot readings): every consumer
 * asks here which identifier to read instead of mixing them.
 */
export type HeartMetric = 'restingHr' | 'hrv' | 'vo2max' | 'steps' | 'heartRate';

const APPLE: Record<HeartMetric, string> = {
  restingHr: 'HKQuantityTypeIdentifierRestingHeartRate',
  hrv: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
  vo2max: 'HKQuantityTypeIdentifierVO2Max',
  steps: 'HKQuantityTypeIdentifierStepCount',
  heartRate: 'HKQuantityTypeIdentifierHeartRate',
};
const DEVICE: Record<HeartMetric, string> = {
  restingHr: 'COROSRestingHeartRate',
  hrv: 'COROSSleepHRV',
  vo2max: 'COROSVO2Max',
  steps: 'COROSSteps',
  heartRate: 'COROSHeartRate',
};

/** 'device' when the watch's own data (COROS cloud, FIT files) should win, else 'apple'. */
export function preferred(
  settings: Pick<AthleteSettings, 'watch' | 'sources'>,
  kind: keyof AthleteSettings['sources'],
): Exclude<SourcePref, 'auto'> {
  const p = settings.sources?.[kind] ?? 'auto';
  if (p !== 'auto') return p;
  return settings.watch === 'apple' ? 'apple' : 'device';
}

const hasMetric = (db: Db, athleteId: number, metric: string) =>
  get(db, 'SELECT 1 FROM daily_metrics WHERE athlete_id = ? AND metric = ? LIMIT 1', [athleteId, metric]) !==
  undefined;

/** daily_metrics key to read for a heart metric: the preferred source when it has data, else the other one. */
export function heartMetric(
  db: Db,
  athleteId: number,
  metric: HeartMetric,
  settings = getSettings(db, athleteId),
): string {
  const first = preferred(settings, 'heart') === 'device' ? DEVICE : APPLE;
  const second = first === DEVICE ? APPLE : DEVICE;
  if (hasMetric(db, athleteId, first[metric]) || !hasMetric(db, athleteId, second[metric]))
    return first[metric];
  return second[metric];
}

/** True when the device's own copy of a workout (FIT file / COROS) should win over the Apple Health copy. */
export function preferDeviceWorkouts(db: Db, athleteId: number): boolean {
  return preferred(getSettings(db, athleteId), 'workouts') === 'device';
}
