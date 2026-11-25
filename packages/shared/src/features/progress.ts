/**
 * API contract for the "progress" feature. Owned by the progress feature module
 * (apps/server/src/features/progress, apps/web/src/features/progress).
 *
 * Everything is mounted under /api/progress. Values are canonical units (m, s, m/s, bpm, W, kcal),
 * days are local 'YYYY-MM-DD' strings. Endpoints that depend on "now" accept `today=YYYY-MM-DD`
 * (the browser's local day); the server's own day is the fallback.
 *
 * All names are prefixed (Progress…) because every feature contract is re-exported from @cadence/shared.
 */
import type { WorkoutSummary } from '../core';

/** Volume metrics that add up per period. `time` is moving time. */
export type ProgressVolumeMetric = 'distance' | 'time' | 'elevation' | 'count' | 'effort';
export const PROGRESS_VOLUME_METRICS: ProgressVolumeMetric[] = ['distance', 'time', 'elevation', 'count', 'effort'];

export type ProgressBucket = 'week' | 'month' | 'year';

export interface ProgressTotals {
  count: number;
  distanceM: number;
  movingS: number;
  durationS: number;
  elevationM: number;
  effort: number;
  energyKcal: number;
}

/** A day range, both ends inclusive. */
export interface ProgressDayRange {
  fromDay: string;
  toDay: string;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface ProgressSport {
  sport: string;
  count: number;
  distanceM: number;
  movingS: number;
  firstDay: string;
  lastDay: string;
  /** Workouts of this sport with at least one best effort. */
  bestEffortWorkouts: number;
}

/** GET /api/progress/overview */
export interface ProgressOverview {
  /** Sports with visible workouts, most frequent first. */
  sports: ProgressSport[];
  /** The most frequent sport (default of the sport filter). */
  defaultSport: string | null;
  firstDay: string | null;
  lastDay: string | null;
  weekStart: 0 | 1;
}

// ---------------------------------------------------------------------------
// Volume, year over year, comparison, weekly snapshot
// ---------------------------------------------------------------------------

export interface ProgressVolumeBucket extends ProgressDayRange {
  /** Week start day 'YYYY-MM-DD', month 'YYYY-MM' or year 'YYYY'. */
  key: string;
  total: ProgressTotals;
  /** Totals per sport (only sports active in this bucket). */
  bySport: Record<string, ProgressTotals>;
}

/** GET /api/progress/volume?sport=&bucket=&fromDay=&toDay= */
export interface ProgressVolumeResponse {
  bucket: ProgressBucket;
  weekStart: 0 | 1;
  /** Contiguous buckets (empty ones included), oldest first. */
  buckets: ProgressVolumeBucket[];
  /** Sports active in the range. */
  sports: string[];
  /** Trailing average of the bucket totals over `rollingWindow` buckets (0 = none, e.g. for years). */
  rollingWindow: number;
  rolling: Record<ProgressVolumeMetric, (number | null)[]>;
  totals: ProgressTotals;
}

export interface ProgressYoyYear {
  year: number;
  total: number;
  /**
   * Cumulative value per day of a leap reference year (366 slots, index 59 = Feb 29; non-leap years repeat
   * Feb 28 there). The current year stops at today.
   */
  cumulative: number[];
}

/** GET /api/progress/yoy?sport=&metric=&today= */
export interface ProgressYoyResponse {
  metric: ProgressVolumeMetric;
  today: string;
  /** Slot of today in the reference year. */
  todayIndex: number;
  /** Oldest first, at most the last 6 years. */
  years: ProgressYoyYear[];
  /** This year to date vs the previous year up to the same date. */
  comparison: {
    year: number;
    value: number;
    previousYear: number;
    previousValue: number;
    diff: number;
    /** diff / previousValue, null when there was nothing last year. */
    pct: number | null;
  } | null;
}

export type ProgressComparePeriod = 'week' | 'month' | 'year' | 'custom';

export interface ProgressCompareTotals extends ProgressTotals {
  activeDays: number;
  /** Distance / moving time; only for a single sport with distance. */
  avgSpeed: number | null;
  /** Duration-weighted average heart rate of workouts with heart rate. */
  avgHr: number | null;
  longestM: number | null;
  longestS: number | null;
}

export interface ProgressCompareRange extends ProgressDayRange {
  totals: ProgressCompareTotals;
}

/** GET /api/progress/compare?sport=&period=&offset=&fromDay=&toDay=&today= */
export interface ProgressCompareResponse {
  period: ProgressComparePeriod;
  /** 0 = current period, 1 = the one before, … (week/month/year). */
  offset: number;
  /** True when the current period is still running and the previous one is cut to the same length. */
  toDate: boolean;
  current: ProgressCompareRange;
  previous: ProgressCompareRange;
}

/** GET /api/progress/snapshot?today= — this week vs last week for the dashboard. */
export interface ProgressWeeklySnapshot {
  weekStart: 0 | 1;
  current: ProgressDayRange & { totals: ProgressTotals };
  /** Last week up to the same weekday. */
  previous: ProgressDayRange & { totals: ProgressTotals };
  /** All of last week. */
  previousFull: ProgressDayRange & { totals: ProgressTotals };
  /** The last 12 weeks including the current one, oldest first. */
  weeks: { key: string; totals: ProgressTotals }[];
}

// ---------------------------------------------------------------------------
// Per-activity trends, pace at heart rate, intensity
// ---------------------------------------------------------------------------

/**
 * speed: average moving speed · hr: average heart rate · ef: efficiency factor (speed / HR = meters per
 * heartbeat; grade adjusted for foot sports, from the speed also for rides with power — the activity analysis'
 * `paceEfficiency`) · cadence: steps (run/walk) or revolutions (ride) per minute · power: average power ·
 * stride / gct / vo: Apple Watch running dynamics (stride length m, ground contact time ms, vertical
 * oscillation m) · decoupling: aerobic decoupling (%) between the halves of the workout after a 5-minute warm-up,
 * the value of the activity page (Pw:HR for rides with power, else Pa:HR on the grade adjusted pace).
 */
export type ProgressTrendMetric = 'speed' | 'hr' | 'ef' | 'cadence' | 'power' | 'stride' | 'gct' | 'vo' | 'decoupling';
export const PROGRESS_TREND_METRICS: ProgressTrendMetric[] = [
  'speed',
  'hr',
  'ef',
  'cadence',
  'power',
  'stride',
  'gct',
  'vo',
  'decoupling',
];

export interface ProgressTrendWorkout {
  id: number;
  name: string;
  sport: string;
  startTs: number;
  tzMin: number;
  distanceM: number | null;
  movingS: number;
}

/** Least-squares line over time. */
export interface ProgressTrendFit {
  /** Change of the value per day. */
  slopePerDay: number;
  startTs: number;
  endTs: number;
  startValue: number;
  endValue: number;
  r2: number;
}

export interface ProgressTrendSeries {
  metric: ProgressTrendMetric;
  /** Canonical unit: 'm/s', 'bpm', 'm/beat', 'spm', 'rpm', 'W', 'm', 'ms', '%'. */
  unit: string;
  /** Direction that counts as an improvement; null = neutral (e.g. average heart rate). */
  better: 'up' | 'down' | null;
  /** [index into ProgressTrendsResponse.workouts, value], chronological. */
  points: [number, number][];
  /** Trailing rolling median over `medianWindow` activities, aligned with points. */
  median: number[];
  medianWindow: number;
  fit: ProgressTrendFit | null;
  /** Change of the fitted line from start to end: relative (0.05 = +5 %) or absolute (`changeKind`). */
  change: number | null;
  changeKind: 'relative' | 'absolute';
  /** Whether `change` is an improvement given `better` (null when neutral or unknown). */
  improved: boolean | null;
}

/** GET /api/progress/trends?sport=&fromDay=&toDay= */
export interface ProgressTrendsResponse {
  sport: string;
  workouts: ProgressTrendWorkout[];
  /** Only metrics with data, in PROGRESS_TREND_METRICS order. */
  series: ProgressTrendSeries[];
}

export interface ProgressHrBand {
  /** Inclusive lower bound (bpm). */
  lo: number;
  /** Exclusive upper bound (bpm). */
  hi: number;
}

export interface PaceAtHrMonth {
  month: string;
  /** Meters / seconds spent inside the band; null when there was too little time in the band. */
  speed: number | null;
  seconds: number;
  distanceM: number;
  workouts: number;
}

/** GET /api/progress/pace-at-hr?sport=&lo=&hi=&fromDay=&toDay= */
export interface PaceAtHrResponse {
  sport: string;
  band: ProgressHrBand;
  /** 'saved' = the band picked last time, 'common' = most frequent 10 bpm, 'z2'/'z3' = HR zones. */
  suggestions: (ProgressHrBand & { key: 'saved' | 'common' | 'z2' | 'z3' })[];
  /** Moving time per bpm over the range (for the band picker), starting at `lo` bpm. */
  hrDistribution: { lo: number; seconds: number[] } | null;
  months: PaceAtHrMonth[];
  /** Weighted least-squares line through the monthly speeds. */
  fit: ProgressTrendFit | null;
  /** Relative speed change of the fitted line (+0.05 = 5 % faster at the same heart rate). */
  change: number | null;
  /** Minimum seconds in the band for a month to count. */
  minSeconds: number;
}

/** GET /api/progress/intensity?sport=&bucket=&fromDay=&toDay= */
export interface ProgressIntensityResponse {
  bucket: 'week' | 'month';
  /** Upper bounds (bpm) of Z1..Z4 the zone times were computed with. */
  zoneBounds: number[];
  buckets: (ProgressDayRange & { key: string; zones: number[]; total: number; easyShare: number | null })[];
  /** easy = Z1+Z2, hard = Z3..Z5 (share of the time with heart rate). */
  totals: { zones: number[]; total: number; easyShare: number | null; hardShare: number | null };
  coverage: { withZones: number; workouts: number };
}

// ---------------------------------------------------------------------------
// Records & race predictor
// ---------------------------------------------------------------------------

export interface ProgressEffortRef {
  workoutId: number;
  name: string;
  sport: string;
  startTs: number;
  tzMin: number;
  elapsedS: number;
}

export interface ProgressEffortRow {
  /** Key from BEST_EFFORTS. */
  effort: string;
  distanceM: number;
  attempts: number;
  allTime: ProgressEffortRef | null;
  thisYear: ProgressEffortRef | null;
  last12m: ProgressEffortRef | null;
}

export type ProgressHighlightKey = 'longest' | 'longestTime' | 'climb' | 'fastest' | 'hardest';

export interface ProgressHighlight {
  key: ProgressHighlightKey;
  /** m, s, m, m/s or effort points depending on the key. */
  value: number;
  workout: WorkoutSummary;
}

/** GET /api/progress/records?sport=&today= */
export interface ProgressRecordsResponse {
  sport: string | null;
  /** Sports with best efforts, most workouts first. */
  sports: { sport: string; workouts: number }[];
  /** One row per BEST_EFFORTS distance of the sport (also without attempts). */
  efforts: ProgressEffortRow[];
  highlights: ProgressHighlight[];
}

/** GET /api/progress/records/history?sport=&effort= */
export interface ProgressEffortHistory {
  sport: string;
  effort: string;
  distanceM: number;
  /** Every attempt, chronological; `pr` = new personal record at that time. */
  attempts: (ProgressEffortRef & { avgHr: number | null; pr: boolean })[];
  /** Fastest 10, best first. */
  top: (ProgressEffortRef & { avgHr: number | null; rank: number })[];
}

export interface RacePrediction {
  key: string;
  distanceM: number;
  /** Riegel (T2 = T1 · (D2/D1)^1.06) from the recent best effort closest in distance. */
  riegel: { elapsedS: number; basis: ProgressEffortRef & { effort: string; distanceM: number } } | null;
  /** Daniels/Gilbert race time for Apple's VO2max used as VDOT. */
  vo2max: { elapsedS: number } | null;
}

/** GET /api/progress/predictions?today= */
export interface ProgressPredictions {
  /** Best efforts of this many days back were used (widened when there were none). */
  windowDays: number;
  riegelExponent: number;
  vo2max: { value: number; day: string } | null;
  targets: RacePrediction[];
}

// ---------------------------------------------------------------------------
// Fitness (training load) & physiology
// ---------------------------------------------------------------------------

/** Form (TSB) zones from fresh to fatigued. */
export type ProgressFormZone = 'transition' | 'fresh' | 'optimal' | 'tired' | 'overreaching';
export const PROGRESS_FORM_ZONES: ProgressFormZone[] = ['transition', 'fresh', 'optimal', 'tired', 'overreaching'];
export type ProgressAcwrStatus = 'low' | 'optimal' | 'elevated' | 'high';
export type ProgressRampStatus = 'normal' | 'elevated' | 'high';

export interface ProgressFitnessDay {
  day: string;
  /** Relative effort of the day. */
  load: number;
  /** Fitness: 42-day exponentially weighted average of the daily load. */
  ctl: number;
  /** Fatigue: 7-day exponentially weighted average. */
  atl: number;
  /** Form: ctl − atl. */
  tsb: number;
  /** ctl − ctl 7 days earlier. */
  ramp: number;
  /** Acute:chronic workload ratio (7-day / 28-day average load), null without chronic load. */
  acwr: number | null;
}

/** GET /api/progress/fitness?sport=&fromDay=&toDay=&today= */
export interface ProgressFitnessResponse {
  /** Days of the requested range (the model itself always starts at the first activity). */
  days: ProgressFitnessDay[];
  current:
    | (ProgressFitnessDay & {
        zone: ProgressFormZone;
        rampStatus: ProgressRampStatus;
        acwrStatus: ProgressAcwrStatus | null;
      })
    | null;
  /** Weekly load sums in the range. */
  weeks: (ProgressDayRange & { key: string; load: number; count: number })[];
  /** TSB bounds of each zone (null = open ended). */
  zones: { key: ProgressFormZone; min: number | null; max: number | null }[];
  thresholds: { rampElevated: number; rampHigh: number; acwrLow: number; acwrHigh: number; acwrDanger: number };
  constants: { ctlDays: number; atlDays: number };
}

export type ProgressVo2Level = 'poor' | 'fair' | 'good' | 'excellent' | 'superior';
export const PROGRESS_VO2_LEVELS: ProgressVo2Level[] = ['poor', 'fair', 'good', 'excellent', 'superior'];

export interface ProgressDayValue {
  day: string;
  value: number;
}

export interface ProgressDailySeries {
  points: ProgressDayValue[];
  /** Trailing 7-day mean aligned with points. */
  avg7: (number | null)[];
  latest: ProgressDayValue | null;
}

/** GET /api/progress/physiology?fromDay=&toDay= */
export interface ProgressPhysiology {
  vo2max: {
    points: ProgressDayValue[];
    /** Trailing 30-day median aligned with points. */
    median: (number | null)[];
    latest: ProgressDayValue | null;
    level: ProgressVo2Level | null;
    /** Level bands for the athlete's age and sex (ACSM / Cooper Institute norms); null without an age. */
    levels: { key: ProgressVo2Level; min: number | null; max: number | null }[] | null;
    age: number | null;
    sex: 'male' | 'female' | 'other' | null;
  };
  restingHr: ProgressDailySeries;
  hrv: ProgressDailySeries;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

/** GET/PATCH /api/progress/preferences (setting 'progress.preferences'). */
export interface ProgressPreferences {
  /** Last heart-rate band picked per sport for "pace at heart rate". */
  hrBands: Record<string, ProgressHrBand>;
}

// ---------------------------------------------------------------------------
// Power curve & FTP estimate
// ---------------------------------------------------------------------------

/**
 * Durations (s) of the power curve. Every workout with a power stream stores its best average power for each of
 * these durations that fits into one part of the workout, so the curve of a period is a maximum per duration.
 */
export const PROGRESS_POWER_DURATIONS: readonly number[] = [
  1, 2, 3, 5, 8, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480, 600, 720, 900, 1200, 1500, 1800, 2700,
  3600, 4500, 5400, 7200, 9000, 10800, 14400, 18000,
];

/** 42d / 90d / 12m end today; 'year' = a calendar year; 'all' = from the first power data; 'custom' = fromDay…toDay. */
export type ProgressPowerPeriod = '42d' | '90d' | '12m' | 'year' | 'all' | 'custom';
export const PROGRESS_POWER_PERIODS: ProgressPowerPeriod[] = ['42d', '90d', '12m', 'year', 'all', 'custom'];

/** Comparison curve: the all-time bests, the period of the same length right before, or none. */
export type ProgressPowerCompare = 'allTime' | 'previous' | 'none';
export const PROGRESS_POWER_COMPARES: ProgressPowerCompare[] = ['allTime', 'previous', 'none'];

/** The workout effort that set a best average power. */
export interface ProgressPowerEffort {
  durationS: number;
  /** Best average power over `durationS` (W). */
  watts: number;
  /** watts / body mass of the curve or estimate; null without a known body mass. */
  wkg: number | null;
  workoutId: number;
  name: string;
  sport: string;
  startTs: number;
  tzMin: number;
  /** Start of the effort in seconds after the workout start. */
  offsetS: number;
}

/** Body mass (kg) from Apple Health: the latest daily value on or before a day. */
export interface ProgressBodyMass {
  kg: number;
  day: string;
}

export interface ProgressPowerCurve extends ProgressDayRange {
  /** Best effort per duration, shortest first; durations no workout of the range covers are left out. */
  points: ProgressPowerEffort[];
  /** Visible workouts with power data in the range. */
  workouts: number;
  /** Latest body mass on or before `toDay`, the basis of W/kg. */
  bodyMass: ProgressBodyMass | null;
}

/** GET /api/progress/power/curve?sport=&period=&year=&fromDay=&toDay=&compare=&today= */
export interface ProgressPowerCurveResponse {
  /** Sport of the curve (default: ride when it has power data, else the sport with the most power workouts). */
  sport: string;
  /** Sports with power data (visible workouts with a power stream), most workouts first. */
  sports: { sport: string; workouts: number }[];
  /** Calendar years with power data of `sport`, newest first. */
  years: number[];
  period: ProgressPowerPeriod;
  compare: ProgressPowerCompare;
  current: ProgressPowerCurve;
  /** null for compare 'none', and for 'previous' / 'allTime' when the period is already all time. */
  comparison: ProgressPowerCurve | null;
}

/** Critical power model P(t) = CP + W′ / t, fitted as work = CP · t + W′ over the 3–20 minute bests. */
export interface ProgressCriticalPower {
  /** Critical power (W). */
  cpW: number;
  /** W′: work capacity above critical power (J). */
  wPrimeJ: number;
  /** Coefficient of determination of the work-vs-time fit. */
  r2: number;
  /** Largest relative deviation of a best from the model's power (0.03 = 3 %). */
  maxError: number;
  /** Durations (s) of the bests used for the fit. */
  durations: number[];
  cpWkg: number | null;
}

export interface ProgressFtpHistoryPoint extends ProgressDayRange {
  /** 'YYYY-MM' (month) or 'YYYY-Qn' (quarter). */
  key: string;
  /** factor × the best 20-minute power of the bucket; null without a 20-minute effort. */
  ftp: number | null;
  /** ftp / the latest body mass at the end of the bucket. */
  ftpWkg: number | null;
  /** The 20-minute effort. */
  source: ProgressPowerEffort | null;
}

/** GET /api/progress/power/ftp?sport=&today= */
export interface ProgressFtpResponse {
  sport: string;
  today: string;
  /** FTP = factor × best 20-minute power (0.95). */
  factor: number;
  /** Days searched for the 20-minute best: 42, or 90 when the last 42 days had none; null without an estimate. */
  windowDays: number | null;
  /** Estimated FTP (W, one decimal); null without a 20-minute effort in the last 90 days. */
  ftp: number | null;
  ftpWkg: number | null;
  /** The 20-minute effort the estimate is based on. */
  source: ProgressPowerEffort | null;
  /** From the bests of the same window; null when there are too few or they do not fit the model. */
  criticalPower: ProgressCriticalPower | null;
  criticalPowerIssue: 'tooFew' | 'poorFit' | null;
  /** Latest body mass on or before today. */
  bodyMass: ProgressBodyMass | null;
  /** The estimate per month (per quarter for more than three years), from the first power data up to today. */
  history: { bucket: 'month' | 'quarter'; points: ProgressFtpHistoryPoint[] };
}
