/**
 * API contract for the "health" feature. Owned by the health feature module
 * (apps/server/src/features/health, apps/web/src/features/health).
 *
 * Endpoints (all under /api/health):
 *   GET  /meta                      HealthMeta
 *   GET  /overview                  HealthOverview
 *   GET  /snapshot                  HealthSnapshot
 *   GET  /daily?metrics=&fromDay=&toDay=   Record<metric, DailyMetric[]>
 *   GET/PUT /settings               HealthSettings
 *   GET  /sleep/nights?fromDay=&toDay=&kind=   SleepNight[]
 *   GET  /sleep/night?day=|id=      SleepNightDetail
 *   GET  /heart/events?fromDay=&toDay=         HeartEvent[]
 *   GET  /intraday?type=&day=&bucket=          IntradayResponse
 *   GET  /body/blood-pressure?fromDay=&toDay=  BloodPressureReading[]
 *   GET  /explorer                  ExplorerResponse
 *   GET  /metric/series?type=&fromDay=&toDay=&agg=   MetricSeries
 *   GET  /metric/sources?type=&fromDay=&toDay=       MetricSources
 *   GET  /metric/samples?type=&from=&to=&limit=&offset=&order=   Page<MetricSample>
 *   GET  /ecg                       EcgSummary[]
 *   GET  /ecg/:id                   EcgDetail
 */
import type { RecordTypeInfo } from '../core';

export * from './health-catalogue';
export * from './health-analytics';

// ---------------------------------------------------------------------------------------------------------------
// Meta, settings
// ---------------------------------------------------------------------------------------------------------------

export interface HealthMeta {
  /** Latest local day with health data (anchor for "last 30 days" ranges); null without data. */
  asOf: string | null;
  /** Earliest local day with any data. */
  firstDay: string | null;
  sleepNights: number;
  ecgCount: number;
  sleepGoalMin: number;
}

export interface HealthSettings {
  /** Nightly sleep goal in minutes (default 480). */
  sleepGoalMin: number;
}

export const DEFAULT_HEALTH_SETTINGS: HealthSettings = { sleepGoalMin: 480 };

// ---------------------------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------------------------

/** Key metrics of the overview, in display order. `metric` is a daily_metrics key (or 'sleep'). */
export const OVERVIEW_METRICS: { key: string; metric: string }[] = [
  { key: 'restingHr', metric: 'HKQuantityTypeIdentifierRestingHeartRate' },
  { key: 'hrv', metric: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN' },
  { key: 'vo2max', metric: 'HKQuantityTypeIdentifierVO2Max' },
  { key: 'walkingHr', metric: 'HKQuantityTypeIdentifierWalkingHeartRateAverage' },
  { key: 'respiratoryRate', metric: 'HKQuantityTypeIdentifierRespiratoryRate' },
  { key: 'spo2', metric: 'HKQuantityTypeIdentifierOxygenSaturation' },
  { key: 'wristTemp', metric: 'HKQuantityTypeIdentifierAppleSleepingWristTemperature' },
  { key: 'sleep', metric: 'sleep' },
  { key: 'weight', metric: 'HKQuantityTypeIdentifierBodyMass' },
  { key: 'bodyFat', metric: 'HKQuantityTypeIdentifierBodyFatPercentage' },
  { key: 'steps', metric: 'HKQuantityTypeIdentifierStepCount' },
  { key: 'activeEnergy', metric: 'HKQuantityTypeIdentifierActiveEnergyBurned' },
  { key: 'exercise', metric: 'HKQuantityTypeIdentifierAppleExerciseTime' },
  { key: 'mindful', metric: 'HKCategoryTypeIdentifierMindfulSession:NotApplicable' },
  { key: 'daylight', metric: 'HKQuantityTypeIdentifierTimeInDaylight' },
];

export const OVERVIEW_SPARK_DAYS = 60;

export interface HealthMetricCard {
  key: string;
  /** daily_metrics key; 'sleep' = asleep minutes per night from the sleep nights table. */
  metric: string;
  /** Latest day with a value and that value (canonical unit; sleep: minutes). */
  latestDay: string | null;
  latest: number | null;
  /** Mean over the last 30 days up to `asOf` (cumulative metrics count days without data as 0). */
  avg30: number | null;
  n30: number;
  /** Mean over the 30 days before that. */
  avgPrev30: number | null;
  nPrev30: number;
  /** Daily values of the last OVERVIEW_SPARK_DAYS days ending at `asOf` (null = no data). */
  spark: (number | null)[];
  firstDay: string | null;
}

export interface HealthOverview {
  asOf: string | null;
  cards: HealthMetricCard[];
}

export interface SnapshotValue {
  day: string;
  value: number;
  /** Last 14 days (index 0 = oldest), null = no data. */
  spark: (number | null)[];
}

export interface HealthSnapshot {
  asOf: string | null;
  restingHr: SnapshotValue | null;
  hrv: SnapshotValue | null;
  steps: SnapshotValue | null;
  /** Value = asleep minutes of the latest night. */
  sleep: (SnapshotValue & { inBedS: number; efficiency: number | null; goalMin: number }) | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Sleep
// ---------------------------------------------------------------------------------------------------------------

export type SleepStage = 'awake' | 'rem' | 'core' | 'deep' | 'asleep';

/** Numeric codes of stages in the stored segment arrays. */
export const SLEEP_STAGE_CODES: SleepStage[] = ['awake', 'rem', 'core', 'deep', 'asleep'];

export interface SleepSegment {
  startTs: number;
  endTs: number;
  stage: SleepStage;
}

export interface SleepNight {
  id: number;
  /** Local day of waking up. */
  day: string;
  kind: 'night' | 'nap';
  bedTs: number;
  wakeTs: number;
  tzBedMin: number;
  tzWakeMin: number;
  /** First / last moment asleep. */
  onsetTs: number | null;
  finalTs: number | null;
  inBedS: number;
  asleepS: number;
  coreS: number;
  deepS: number;
  remS: number;
  /** Asleep without stage information (older watchOS / third-party apps). */
  unspecS: number;
  awakeS: number;
  awakenings: number;
  /** Time from getting into bed to falling asleep. */
  latencyS: number | null;
  /** asleep / in bed (0..1). */
  efficiency: number | null;
  /** True when the night has Core/Deep/REM stage detail. */
  staged: boolean;
  source: string | null;
}

export interface TimedValue {
  ts: number;
  value: number;
}

export interface SleepPhysiology {
  /** Heart rate during the night (5-minute means when there are many samples). */
  hr: TimedValue[];
  hrMin: number | null;
  hrAvg: number | null;
  /** SDNN samples (ms) recorded during the night. */
  hrv: TimedValue[];
  hrvAvg: number | null;
  resp: TimedValue[];
  respAvg: number | null;
  /** Blood oxygen as fraction 0..1. */
  spo2: TimedValue[];
  spo2Avg: number | null;
  wristTemp: { value: number; baseline: number | null; delta: number | null } | null;
}

export interface SleepNightDetail extends SleepNight {
  segments: SleepSegment[];
  physiology: SleepPhysiology;
}

// ---------------------------------------------------------------------------------------------------------------
// Heart
// ---------------------------------------------------------------------------------------------------------------

export type HeartEventType = 'high' | 'low' | 'irregular' | 'lowCardio';

export interface HeartEvent {
  type: HeartEventType;
  ts: number;
  tzMin: number;
  /** bpm threshold the notification was configured with (high / low). */
  threshold: number | null;
  source: string | null;
}

export interface IntradayBucket {
  ts: number;
  avg: number;
  min: number;
  max: number;
  n: number;
}

export interface IntradayResponse {
  type: string;
  day: string;
  unit: string | null;
  aggregation: RecordTypeInfo['aggregation'];
  /** Local UTC offset in minutes of the day (offset of the first sample). */
  tzMin: number;
  dayStartTs: number;
  dayEndTs: number;
  bucketS: number;
  sampleCount: number;
  /** For cumulative types `avg` = `min` = `max` = the bucket total. */
  buckets: IntradayBucket[];
}

// ---------------------------------------------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------------------------------------------

export interface BloodPressureReading {
  ts: number;
  tzMin: number;
  day: string;
  systolic: number;
  diastolic: number;
  pulse: number | null;
  source: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Explorer & metric page
// ---------------------------------------------------------------------------------------------------------------

export const EXPLORER_SPARK_DAYS = 90;

export interface ExplorerType extends RecordTypeInfo {
  /** Last EXPLORER_SPARK_DAYS days up to `asOf` (null = no data). Category types: minutes (or event count). */
  spark: (number | null)[];
}

export interface ExplorerItem {
  /** 'activitySummaries' | 'ecg' | 'audiogram' | 'clinicalRecord' | 'visionPrescription' | 'correlations' | 'workouts' | 'routes' | 'other:<kind>' */
  key: string;
  count: number;
  firstTs: number | null;
  lastTs: number | null;
}

export interface ExplorerResponse {
  asOf: string | null;
  types: ExplorerType[];
  items: ExplorerItem[];
}

export type MetricAgg = 'day' | 'week' | 'month';

export interface MetricPoint {
  /** Period start: the day, the first day of the week (per settings.weekStart) or 'YYYY-MM-01'. */
  key: string;
  /** Daily total ('sum') / mean of daily means ('avg') / minutes ('duration') summed over the period. */
  value: number;
  /** Lowest / highest sample of the period ('avg' types only). */
  min: number | null;
  max: number | null;
  /** Number of samples (events for category types). */
  n: number;
  /** Days with data in the period. */
  days: number;
}

export interface MetricCategorySeries {
  /** Category value, e.g. 'AsleepCore'. */
  value: string;
  total: number;
  points: MetricPoint[];
}

export interface MetricStats {
  /** Days with data in the range. */
  days: number;
  samples: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  /** Sum of daily totals ('sum' / 'duration' types). */
  total: number | null;
  latestDay: string | null;
  latest: number | null;
  firstDay: string | null;
}

export interface MetricSeries {
  type: RecordTypeInfo;
  agg: MetricAgg;
  fromDay: string | null;
  toDay: string | null;
  /** 'sum' and 'avg' types. */
  points: MetricPoint[];
  /** Category types: one series per category value. */
  categories: MetricCategorySeries[];
  stats: MetricStats;
}

export interface MetricSourceRow {
  sourceId: number;
  name: string;
  count: number;
  firstTs: number;
  lastTs: number;
  devices: string[];
}

export interface MetricSources {
  type: string;
  total: number;
  sources: MetricSourceRow[];
}

export interface MetricSample {
  startTs: number;
  endTs: number;
  tzMin: number;
  value: number | null;
  text: string | null;
  source: string | null;
  device: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// ECG
// ---------------------------------------------------------------------------------------------------------------

export type EcgClass = 'sinus' | 'afib' | 'highHr' | 'lowHr' | 'inconclusive' | 'poor' | 'unrecognized' | 'other';

export interface EcgSummary {
  id: number;
  recordedTs: number;
  tzMin: number;
  /** Classification as exported (language of the phone). */
  classification: string | null;
  classKey: EcgClass;
  symptoms: string | null;
  device: string | null;
  softwareVersion: string | null;
  sampleRateHz: number | null;
  durationS: number | null;
  /** Average heart rate computed from the R peaks. */
  avgHr: number | null;
  lead: string | null;
}

export interface EcgDetail extends EcgSummary {
  /** Voltage samples in µV (rounded to whole µV). */
  samples: number[];
  /** R-peak sample indices. */
  rPeaks: number[];
}
