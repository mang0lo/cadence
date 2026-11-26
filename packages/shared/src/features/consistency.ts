/**
 * API contract for the "consistency" feature. Owned by the consistency feature module
 * (apps/server/src/features/consistency, apps/web/src/features/consistency).
 *
 * Every endpoint that depends on "today" accepts `?today=YYYY-MM-DD` (the browser's local day).
 * `asOf` is the day the numbers refer to: today, or the last day covered by the imported data when
 * the latest export is older (streaks and goals are judged "as of" that day).
 */
import type { WorkoutSummary } from '../core';
import { sportInfo } from '../sports';

// ---------------------------------------------------------------------------
// Streaks & consistency score
// ---------------------------------------------------------------------------

export interface StreakInfo {
  /** Length of the streak that is still alive as of `asOf` (0 = none). */
  current: number;
  currentStart: string | null;
  longest: number;
  longestStart: string | null;
  longestEnd: string | null;
  /** The streak is alive through the previous day/week but `asOf` itself does not count yet. */
  pending: boolean;
}

export interface WeeklyStreakInfo extends StreakInfo {
  /** Active days so far in the week containing `asOf`. */
  thisWeek: number;
  /** Active days a week needs to count (≥ 1). */
  minPerWeek: number;
}

export interface RingStreaks {
  move: StreakInfo;
  exercise: StreakInfo;
  stand: StreakInfo;
  /** All three rings closed. */
  all: StreakInfo;
}

export interface StreakSummary {
  today: string;
  asOf: string;
  weekStart: 0 | 1;
  daily: StreakInfo;
  weekly: WeeklyStreakInfo;
  /** null when there is no Apple activity ring data. */
  rings: RingStreaks | null;
  /** The 14 days up to `asOf` (oldest first). */
  recent: { day: string; active: boolean }[];
}

export type ScoreBasis = 'days' | 'goals';

/** Per-athlete preferences of the consistency page (settings key `consistency.prefs`). */
export interface ConsistencyPrefs {
  /** A week counts when it has ≥ minActiveDays active days ('days') or meets every weekly goal ('goals'). */
  scoreBasis: ScoreBasis;
  minActiveDays: number;
}

export const DEFAULT_CONSISTENCY_PREFS: ConsistencyPrefs = { scoreBasis: 'days', minActiveDays: 3 };

export interface ScoreWeek {
  weekStart: string;
  activeDays: number;
  activities: number;
  durationS: number;
  met: boolean;
  /** The week containing `asOf` (not part of the score yet). */
  inProgress: boolean;
}

export interface ConsistencyScore {
  /** Basis actually used ('goals' falls back to 'days' without weekly goals). */
  basis: ScoreBasis;
  minActiveDays: number;
  /** Weekly goals that a week must all meet (basis 'goals'). */
  weeklyGoals: number;
  /** met / total, null before the first complete week with data. */
  score: number | null;
  met: number;
  /** Complete weeks in the 12-week window since the first data (≤ 12). */
  total: number;
  /** The last 12 complete weeks (oldest first) followed by the week in progress. */
  weeks: ScoreWeek[];
  /** Rolling 12-week score for each of the last 52 complete weeks (oldest first). */
  trend: { weekStart: string; score: number | null }[];
}

export interface ConsistencyOverview {
  today: string;
  asOf: string;
  weekStart: 0 | 1;
  /** First day with any activity or ring data. */
  firstDay: string | null;
  /** Years with data, ascending (always contains the year of `asOf`). */
  years: number[];
  streaks: StreakSummary;
  activeDays: {
    year: number;
    thisYear: number;
    /** Active days of the previous year up to the same date. */
    lastYearToDate: number;
    thisMonth: number;
    last30: number;
  };
  score: ConsistencyScore;
  prefs: ConsistencyPrefs;
}

// ---------------------------------------------------------------------------
// Calendar, day detail, punchcard
// ---------------------------------------------------------------------------

/** One local day: workout totals (hidden/duplicates excluded) + activity ring fractions (value / goal). */
export interface CalendarDay {
  day: string;
  count: number;
  durationS: number;
  distanceM: number;
  elevationM: number;
  effort: number;
  energyKcal: number;
  sports: string[];
  move: number | null;
  exercise: number | null;
  stand: number | null;
}

export interface CalendarResponse {
  from: string;
  to: string;
  years: number[];
  /** Only days with activities or ring data, ascending. */
  days: CalendarDay[];
}

export interface RingValues {
  moveKcal: number | null;
  moveGoalKcal: number | null;
  /** Move minutes (only when the Move ring is set to minutes, e.g. for kids / wheelchair users). */
  moveMin: number | null;
  moveGoalMin: number | null;
  exerciseMin: number | null;
  exerciseGoalMin: number | null;
  standHours: number | null;
  standGoalHours: number | null;
  /** Fractions value / goal (null without goal). */
  move: number | null;
  exercise: number | null;
  stand: number | null;
}

export interface DayHealth {
  steps: number | null;
  walkRunDistanceM: number | null;
  flights: number | null;
  activeEnergyKcal: number | null;
  exerciseMin: number | null;
  restingHr: number | null;
  /** Asleep minutes of the night that ended on this day (the sleep pages' night: one source, COROS included). */
  sleepMin: number | null;
}

export interface DayDetail {
  day: string;
  workouts: WorkoutSummary[];
  rings: RingValues | null;
  health: DayHealth;
}

export interface PunchcardCell {
  /** 0 = Sunday … 6 = Saturday (local time of the activity). */
  weekday: number;
  hour: number;
  count: number;
  durationS: number;
}

export interface PunchcardResponse {
  /** null = all time */
  year: number | null;
  total: number;
  cells: PunchcardCell[];
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export type GoalPeriod = 'day' | 'week' | 'month' | 'year';
/**
 * `longest`: the longest single activity of the period (e.g. "run a marathon this year"); `calories`: active energy
 * of the activities (kcal).
 */
export type GoalMetric = 'distance' | 'longest' | 'time' | 'elevation' | 'calories' | 'activities' | 'active_days';

export const GOAL_PERIODS: readonly GoalPeriod[] = ['day', 'week', 'month', 'year'];
export const GOAL_METRICS: readonly GoalMetric[] = [
  'distance',
  'longest',
  'time',
  'elevation',
  'calories',
  'activities',
  'active_days',
];

/** Sport groups whose activities climb (elevation goals make sense). */
const CLIMBING_GROUPS: ReadonlySet<string> = new Set(['foot', 'cycle', 'winter']);

/**
 * The measures a goal can have for a sport (null = all sports) and period: distance only where the sport records
 * one, elevation only where it climbs, and no "active days" for a single day (that is "1 activity").
 */
export function goalMetricsFor(sport: string | null, period: GoalPeriod): GoalMetric[] {
  const info = sport === null ? null : sportInfo(sport);
  const distance = info === null || info.distance;
  const climbs = info === null || (info.distance && CLIMBING_GROUPS.has(info.group));
  return GOAL_METRICS.filter((m) => {
    if (m === 'distance' || m === 'longest') return distance;
    if (m === 'elevation') return climbs;
    if (m === 'active_days') return period !== 'day';
    return true;
  });
}

/** Classic single-activity distances (m) for `longest` goals and trophies, by sport. */
export const LONGEST_PRESETS: Record<'run' | 'ride' | 'swim', { key: string; distanceM: number }[]> = {
  run: [
    { key: '5k', distanceM: 5000 },
    { key: '10k', distanceM: 10000 },
    { key: 'half', distanceM: 21097.5 },
    { key: 'marathon', distanceM: 42195 },
    { key: 'ultra50', distanceM: 50000 },
    { key: 'ultra100', distanceM: 100000 },
  ],
  ride: [
    { key: 'olympicBike', distanceM: 40000 },
    { key: 'halfIronmanBike', distanceM: 90000 },
    { key: 'century', distanceM: 100000 },
    { key: 'imperialCentury', distanceM: 160934.4 },
    { key: 'ironmanBike', distanceM: 180246 },
    { key: 'ride200', distanceM: 200000 },
  ],
  swim: [
    { key: 'olympicSwim', distanceM: 1500 },
    { key: 'halfIronmanSwim', distanceM: 1900 },
    { key: 'ironmanSwim', distanceM: 3800 },
    { key: 'swim5k', distanceM: 5000 },
    { key: 'swim10k', distanceM: 10000 },
  ],
};

/** Triathlon distances (m) per leg: swim, bike, run. */
export const TRIATHLON_DISTANCES: { key: 'olympicTri' | 'halfIronman' | 'ironman'; swim: number; ride: number; run: number }[] = [
  { key: 'olympicTri', swim: 1500, ride: 40000, run: 10000 },
  { key: 'halfIronman', swim: 1900, ride: 90000, run: 21097.5 },
  { key: 'ironman', swim: 3800, ride: 180246, run: 42195 },
];

/** Target in canonical units: distance/elevation m, time s, calories kcal, activities/active days count. */
export interface GoalInput {
  period: GoalPeriod;
  /** null = all sports */
  sport: string | null;
  metric: GoalMetric;
  target: number;
}

export interface Goal extends GoalInput {
  id: number;
  position: number;
  createdAt: number;
}

/** `open`: a daily or single-activity (`longest`) goal that is not reached yet — it has no linear pace to judge. */
export type GoalStatus = 'done' | 'on_track' | 'behind' | 'open';

export interface GoalPeriodProgress {
  start: string;
  end: string;
  value: number;
  target: number;
  /** value / target (may exceed 1). */
  fraction: number;
  /** Days of the period before `asOf`. */
  elapsedDays: number;
  totalDays: number;
  /** Value a linear pace would have reached by the start of `asOf`. */
  expected: number;
  /** Linear projection to the end of the period. */
  projected: number;
  status: GoalStatus;
  remaining: number;
  /** Days left including `asOf`. */
  remainingDays: number;
  /** remaining / remainingDays (null when done or no days left). */
  perDayNeeded: number | null;
  /** Checked off by hand (something was not tracked): the period counts as reached whatever `value` says. */
  checked: boolean;
}

export interface GoalPeriodResult {
  start: string;
  end: string;
  value: number;
  hit: boolean;
  /** Reached because it was checked off by hand, not by the tracked activities. */
  manual?: boolean;
  /** The imported data does not cover the whole period yet: neither reached nor missed. */
  pending?: boolean;
}

export interface GoalWithProgress extends Goal {
  current: GoalPeriodProgress;
  /** Completed periods since the first data, oldest first (≤ 14 days / 12 weeks / 12 months / 5 years). */
  history: GoalPeriodResult[];
  hitRate: number | null;
}

/** PUT /api/consistency/goals/:id/check: the period that was checked off (or unchecked). */
export interface GoalCheckResult {
  start: string;
  end: string;
  done: boolean;
}

export interface GoalSuggestion extends GoalInput {
  /** Average per period over the recent complete periods. */
  average: number;
  periods: number;
}

export interface GoalsResponse {
  today: string;
  asOf: string;
  weekStart: 0 | 1;
  goals: GoalWithProgress[];
  suggestions: GoalSuggestion[];
}

// ---------------------------------------------------------------------------
// Trophies & monthly challenges
// ---------------------------------------------------------------------------

export type AchievementTier = 'bronze' | 'silver' | 'gold';
export const ACHIEVEMENT_TIERS: readonly AchievementTier[] = ['bronze', 'silver', 'gold'];

export type AchievementGroup =
  | 'milestones'
  | 'distance'
  | 'longest'
  | 'climbing'
  | 'streaks'
  | 'habits'
  | 'rings'
  | 'challenges';

export const ACHIEVEMENT_GROUPS: readonly AchievementGroup[] = [
  'milestones',
  'distance',
  'longest',
  'climbing',
  'streaks',
  'habits',
  'rings',
  'challenges',
];

export type AchievementKind =
  | 'activities'
  | 'sport_distance'
  | 'longest'
  | 'elevation'
  | 'daily_streak'
  | 'weekly_streak'
  | 'early_bird'
  | 'night_owl'
  | 'weekend_warrior'
  | 'variety'
  | 'move_streak'
  | 'exercise_streak'
  | 'stand_streak'
  | 'perfect_week'
  | 'double_move'
  | 'challenges'
  /** Swim, bike and run legs of a triathlon distance on one day (threshold = total distance). */
  | 'triathlon';

export interface AchievementWorkout {
  id: number;
  name: string;
  sport: string;
  startTs: number;
  tzMin: number;
}

export interface Achievement {
  key: string;
  group: AchievementGroup;
  kind: AchievementKind;
  tier: AchievementTier;
  sport: string | null;
  /** Threshold in the kind's unit: m (distance, elevation), count, days or weeks. */
  threshold: number;
  /** Special name for well-known thresholds ('marathon', 'everest', …), else null. */
  name: string | null;
  /** Current value towards the threshold (best/cumulative so far). */
  progress: number;
  earned: boolean;
  earnedDay: string | null;
  /**
   * Activity that earned it: for streaks the first activity of the day (or week) that completed them; null for ring
   * achievements and when no single activity applies.
   */
  workout: AchievementWorkout | null;
  /** Earned since the last few imports (within 14 days of being detected). */
  isNew: boolean;
}

export type ChallengeKey = 'run50' | 'run100' | 'ride200' | 'climb1000' | 'activities10' | 'runs5k' | 'active20';
export type ChallengeMetric = 'distance' | 'elevation' | 'activities' | 'runs5k' | 'active_days';

export interface ChallengeDef {
  key: ChallengeKey;
  metric: ChallengeMetric;
  sport: string | null;
  /** m for distance/elevation, count otherwise. */
  target: number;
}

export interface ChallengeProgress {
  key: ChallengeKey;
  value: number;
  target: number;
  completedDay: string | null;
}

export interface ChallengeMonth {
  /** 'YYYY-MM' */
  month: string;
  items: ChallengeProgress[];
  completed: number;
}

export interface TrophiesResponse {
  today: string;
  asOf: string;
  achievements: Achievement[];
  summary: {
    earned: number;
    total: number;
    tiers: Record<AchievementTier, { earned: number; total: number }>;
  };
  challenges: {
    defs: ChallengeDef[];
    /** The month containing `asOf`. */
    current: ChallengeMonth & { daysLeft: number; totalDays: number };
    /** Earlier months since the first activity, newest first. */
    history: ChallengeMonth[];
    /** All completed challenges ever. */
    completedTotal: number;
  };
}

// ---------------------------------------------------------------------------
// Year in review
// ---------------------------------------------------------------------------

export interface YearTotals {
  activities: number;
  activeDays: number;
  durationS: number;
  distanceM: number;
  elevationM: number;
  energyKcal: number;
  effort: number;
}

export interface YearWorkoutRef {
  id: number;
  name: string;
  sport: string;
  startTs: number;
  tzMin: number;
  durationS: number;
  distanceM: number | null;
  elevationGainM: number | null;
}

export interface YearSport {
  sport: string;
  count: number;
  durationS: number;
  distanceM: number;
  elevationM: number;
}

export interface YearMonth {
  /** 'YYYY-MM' */
  month: string;
  count: number;
  durationS: number;
  distanceM: number;
  elevationM: number;
  activeDays: number;
}

export interface YearEffort {
  sport: string;
  effort: string;
  distanceM: number;
  elapsedS: number;
  /** All-time best before this year (null = first time this distance was covered). */
  previousBestS: number | null;
  /** How often the all-time best was improved during the year. */
  improvements: number;
  workout: YearWorkoutRef;
}

export interface YearStreak {
  length: number;
  start: string;
  end: string;
}

export interface YearHealthValue {
  value: number | null;
  prev: number | null;
}

export interface YearHealth {
  restingHr: YearHealthValue;
  hrv: YearHealthValue;
  vo2max: YearHealthValue;
  stepsPerDay: YearHealthValue;
  stepsTotal: number | null;
  bestStepsDay: { day: string; value: number } | null;
  /** Mean asleep minutes per night (nights of more than an hour, by wake-up day). */
  sleepPerNightMin: YearHealthValue;
  activeEnergyKcal: YearHealthValue;
  flights: YearHealthValue;
  weightStart: number | null;
  weightEnd: number | null;
}

export interface YearReview {
  year: number;
  years: number[];
  today: string;
  asOf: string;
  /** First day with any data (a previous year may only be partially covered). */
  firstDay: string | null;
  /** False while the year is still running (comparisons use the previous year up to the same date). */
  complete: boolean;
  totals: YearTotals;
  /** Previous year (to the same date while this year is incomplete); null without data. */
  previous: YearTotals | null;
  bySport: YearSport[];
  months: YearMonth[];
  topMonth: YearMonth | null;
  longest: YearWorkoutRef | null;
  longestTime: YearWorkoutRef | null;
  biggestClimb: YearWorkoutRef | null;
  first: YearWorkoutRef | null;
  /** The year's best time for the headline distances. */
  fastest: YearEffort[];
  /** All-time bests set during the year (final best of the year per distance). */
  prs: YearEffort[];
  /** Activities per local weekday (0 = Sunday) and hour of day. */
  weekdays: number[];
  hours: number[];
  streaks: { daily: YearStreak | null; weekly: YearStreak | null };
  rings: { days: number; move: number; exercise: number; stand: number; all: number } | null;
  trophies: Achievement[];
  health: YearHealth;
}
