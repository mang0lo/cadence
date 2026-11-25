/**
 * API contract for the "activities" feature. Owned by the activities feature module
 * (apps/server/src/features/activities, apps/web/src/features/activities).
 *
 * Endpoints (mounted under /api/activities):
 *   GET /summary?today=&weekStart=   → ActivitiesSummary   (athlete card on the dashboard)
 *   GET /list?…                      → ActivityListPage    (feed + activities list, with medals and totals)
 *   GET /:id/nav                     → ActivityNav         (previous / next activity)
 *   GET /:id/analysis                → ActivityAnalysis    (computed from the streams, cached)
 *   GET /:id/similar                 → ActivitySimilar     (similar efforts for the comparison chart)
 *
 * All values are canonical units (m, s, m/s, bpm, W); never localised on the server.
 */
import type { Page, WorkoutSummary } from '../core';

// ---------------------------------------------------------------------------
// Totals & dashboard summary
// ---------------------------------------------------------------------------

/** Totals over a set of workouts. `movingS` falls back to the active duration for workouts without GPS. */
export interface ActivityTotals {
  count: number;
  distanceM: number;
  movingS: number;
  elevationM: number;
  energyKcal: number;
  effort: number;
}

export interface ActivitySportTotals {
  sport: string;
  allTime: ActivityTotals;
  thisYear: ActivityTotals;
  thisWeek: ActivityTotals;
}

export interface ActivityWeekDay {
  /** Local day 'YYYY-MM-DD'. */
  day: string;
  totals: ActivityTotals;
  sports: { sport: string; count: number; movingS: number; distanceM: number }[];
}

/** GET /api/activities/summary?today=YYYY-MM-DD&weekStart=0|1 (defaults: server today, settings.weekStart). */
export interface ActivitiesSummary {
  athleteName: string;
  today: string;
  /** First day of the current week (respects weekStart). */
  weekStartDay: string;
  /** 'YYYY-01-01' of the current year. */
  yearStartDay: string;
  allTime: ActivityTotals;
  thisYear: ActivityTotals;
  thisWeek: ActivityTotals;
  lastWeek: ActivityTotals;
  /** One entry per sport, most activities (all time) first. */
  sports: ActivitySportTotals[];
  /** The 7 days of the current week. */
  week: ActivityWeekDay[];
  firstActivityTs: number | null;
  lastActivityTs: number | null;
  /** Best efforts set in the last 30 days that are still the all-time best (rank 1). */
  recentPrs: number;
}

// ---------------------------------------------------------------------------
// Feed / list
// ---------------------------------------------------------------------------

/** A best effort of a workout that currently ranks 1–3 among the athlete's visible workouts. */
export interface ActivityMedal {
  effort: string;
  distanceM: number;
  elapsedS: number;
  rank: 1 | 2 | 3;
}

export interface ActivityListItem extends WorkoutSummary {
  /** Medals sorted by rank, then longest distance first. */
  medals: ActivityMedal[];
}

export type ActivitySort = 'start' | 'distance' | 'time' | 'pace' | 'elevation' | 'hr' | 'effort';

/** GET /api/activities/list query (same filters as GET /api/workouts plus more sort keys). */
export interface ActivityListQuery {
  /** Comma separated sport keys. */
  sport?: string;
  /** Start time range, unix seconds (from inclusive, to exclusive). */
  from?: number;
  to?: number;
  q?: string;
  hasRoute?: boolean;
  includeHidden?: boolean;
  /** 'time' = moving time, 'pace' = average speed. */
  sort?: ActivitySort;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface ActivityListPage extends Page<ActivityListItem> {
  /** Totals of everything matching the filter (not only this page). */
  totals: ActivityTotals;
}

// ---------------------------------------------------------------------------
// Detail helpers
// ---------------------------------------------------------------------------

export interface ActivityNeighbor {
  id: number;
  name: string;
  sport: string;
  startTs: number;
  tzMin: number;
}

/** GET /api/activities/:id/nav — chronological neighbours among visible activities. */
export interface ActivityNav {
  /** The activity before this one (older). */
  prev: ActivityNeighbor | null;
  /** The activity after this one (newer). */
  next: ActivityNeighbor | null;
}

// ---------------------------------------------------------------------------
// Analysis (GET /api/activities/:id/analysis)
// ---------------------------------------------------------------------------

/** Aerobic decoupling: output:HR of the first vs the second half of the moving time after the warm-up. */
export interface ActivityDecoupling {
  /** 'pace' = (grade adjusted) speed : heart rate, 'power' = power : heart rate. */
  basis: 'pace' | 'power';
  /** Average output (m/s or W) and heart rate of each half. */
  first: { output: number; hr: number };
  second: { output: number; hr: number };
  /**
   * (ratio₁ − ratio₂) / ratio₁ × 100. Below 5 % = well coupled (aerobically fit for this effort). Values beyond
   * ±60 % are recording problems and left out.
   */
  pct: number;
}

/** Efficiency factor: output per heartbeat. */
export interface ActivityEfficiency {
  /** gap/speed: meters per minute per bpm; power: watts per bpm. */
  value: number;
  basis: 'gap' | 'speed' | 'power';
}

export type ClimbCategory = 'hc' | '1' | '2' | '3' | '4';

export interface ActivityClimb {
  /** Seconds since workout start. */
  startT: number;
  endT: number;
  /** Distance from the start (m). */
  startDistM: number;
  endDistM: number;
  lengthM: number;
  gainM: number;
  startEleM: number;
  endEleM: number;
  /** Fractions (0.06 = 6 %). */
  avgGrade: number;
  maxGrade: number;
  durationS: number;
  /** Vertical ascent speed in m/h. */
  vam: number;
  avgHr: number | null;
  /** Strava-style category from length × grade, null = uncategorized. */
  category: ClimbCategory | null;
}

export interface ActivityLap {
  idx: number;
  /** 'lap' (manual laps, pool lengths) or 'segment' (auto splits, swim sets). */
  kind: 'lap' | 'segment';
  /** Seconds since workout start. */
  startT: number;
  endT: number;
  durationS: number;
  distanceM: number | null;
  movingS: number;
  avgSpeed: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  avgPower: number | null;
  elevGainM: number | null;
  /** Swimming: 'freestyle' | 'backstroke' | 'breaststroke' | 'butterfly' | 'mixed' | 'kickboard'. */
  strokeStyle: string | null;
  /** Swimming: pool lengths in this lap / set. */
  lengths: number | null;
}

export interface ActivityPowerPeak {
  durationS: number;
  watts: number;
}

export interface ActivityPower {
  avgW: number;
  maxW: number;
  /** 30 s rolling average to the 4th power (Coggan). */
  normalizedW: number | null;
  /** NP / average power. */
  variabilityIndex: number | null;
  /** NP / FTP — rides only, when an FTP is set in the settings. */
  intensityFactor: number | null;
  /** Training stress score — rides only, when an FTP is set. */
  tss: number | null;
  peaks: ActivityPowerPeak[];
}

export interface ActivityAnalysis {
  workoutId: number;
  /** False when the workout has no streams; everything else is then empty/null. */
  hasStreams: boolean;
  /** Average speed over the moving time computed from the streams (m/s). */
  avgSpeed: number | null;
  /** Grade adjusted average speed over the moving time (m/s) — foot sports with elevation data. */
  gapSpeed: number | null;
  /** Power based for rides with power, else from the (grade adjusted) speed. */
  efficiency: ActivityEfficiency | null;
  /**
   * Efficiency from the (grade adjusted) speed ('gap' / 'speed' basis), also for rides with power where `efficiency`
   * is power based. Progress → Trends plots it as "efficiency" (m per beat = m/min per bpm).
   */
  paceEfficiency?: ActivityEfficiency | null;
  /**
   * Power based for rides with power, else from the (grade adjusted) speed. Leaves out the first 5 minutes of moving
   * time (warm-up) and needs 20 more minutes. Progress → Trends shows the same value.
   */
  decoupling: ActivityDecoupling | null;
  climbs: ActivityClimb[];
  /** From 'lap' workout events. */
  laps: ActivityLap[];
  /** From 'segment' workout events. */
  segments: ActivityLap[];
  power: ActivityPower | null;
  /** Elapsed time minus moving time (s). */
  stoppedS: number;
  /** Unix seconds when this analysis was computed. */
  computedAt: number;
}

// ---------------------------------------------------------------------------
// Similar activities (GET /api/activities/:id/similar)
// ---------------------------------------------------------------------------

export interface ActivitySimilarItem {
  id: number;
  name: string;
  sport: string;
  startTs: number;
  tzMin: number;
  distanceM: number | null;
  movingS: number | null;
  durationS: number;
  avgSpeed: number | null;
  /** Grade adjusted speed from the analysis (null until analysed / not a foot sport). */
  gapSpeed: number | null;
  avgHr: number | null;
  elevationGainM: number | null;
  effort: number | null;
  /**
   * Efficiency factor on `ActivitySimilar.efficiencyBasis` (never mixed units); null when the activity has none on
   * that basis.
   */
  efficiency: number | null;
  /** Same start and finish (±300 m) and distance (±10 %) as the activity asked for. */
  sameRoute: boolean;
  /** The activity asked for. */
  current: boolean;
}

export interface ActivitySimilar {
  workoutId: number;
  sport: string;
  /** 'distance' = same sport within ±15 % distance; 'duration' = same sport within ±25 % duration. */
  basis: 'distance' | 'duration';
  /**
   * Basis of every `items[].efficiency`: the current activity's efficiency basis (else the most common one).
   * Rides with power compare W per bpm with other rides with power; rides without power compare the speed based
   * efficiency of all rides.
   */
  efficiencyBasis?: ActivityEfficiency['basis'] | null;
  /** The distance (m) or duration (s) window used. */
  min: number;
  max: number;
  /** Chronological, including the current activity. */
  items: ActivitySimilarItem[];
  /** 1 = fastest (distance basis) / hardest effort (duration basis) among `items`. */
  rank: number | null;
  count: number;
  /** Rank and count among `sameRoute` items (including the current one). */
  routeRank: number | null;
  routeCount: number;
}

// ---------------------------------------------------------------------------
// Pure helpers shared by server analysis and the web UI
// ---------------------------------------------------------------------------

/** Foot sports whose effort depends on the gradient (grade adjusted pace). */
export const GAP_SPORTS = ['run', 'walk', 'hike', 'track_and_field', 'wheelchair'] as const;

/**
 * Energy cost of locomotion on a gradient relative to the flat (Minetti et al. 2002), i.e. how many meters of
 * flat ground one meter at `grade` is worth. Running: C(i) = 155.4i⁵ − 30.4i⁴ − 43.3i³ + 46.3i² + 19.5i + 3.6;
 * walking/hiking: C(i) = 280.5i⁵ − 58.7i⁴ − 76.8i³ + 51.9i² + 19.6i + 2.5. The grade is clamped to ±45 %.
 */
export function gradeCostFactor(grade: number, sport = 'run'): number {
  if (!Number.isFinite(grade)) return 1;
  const i = Math.max(-0.45, Math.min(0.45, grade));
  const walking = sport === 'walk' || sport === 'hike';
  const c = walking
    ? 280.5 * i ** 5 - 58.7 * i ** 4 - 76.8 * i ** 3 + 51.9 * i ** 2 + 19.6 * i + 2.5
    : 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
  return c / (walking ? 2.5 : 3.6);
}

/** Strava-style climb category from length (m) × average grade (%). */
export function climbCategory(lengthM: number, avgGrade: number): ClimbCategory | null {
  const score = lengthM * avgGrade * 100;
  if (score >= 80_000) return 'hc';
  if (score >= 64_000) return '1';
  if (score >= 32_000) return '2';
  if (score >= 16_000) return '3';
  if (score >= 8_000) return '4';
  return null;
}
