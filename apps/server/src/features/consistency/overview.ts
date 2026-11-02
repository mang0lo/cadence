/** Consistency page data: streaks, active days, score, calendar, day detail and the weekday × hour punchcard. */
import {
  DEFAULT_CONSISTENCY_PREFS,
  type CalendarDay,
  type CalendarResponse,
  type ConsistencyOverview,
  type ConsistencyPrefs,
  type DayDetail,
  type DayHealth,
  type PunchcardCell,
  type PunchcardResponse,
  type RingValues,
  type StreakSummary,
} from '@cadence/shared';
import { all, type Db } from '../../db/db';
import { getSetting, setSetting } from '../../core/settings';
import { SUMMARY_COLS, toSummary, type WorkoutRow } from '../../core/workouts';
import { localDay } from '../../lib/time';
import { closed } from './achievements';
import {
  firstDataDay,
  loadActiveDays,
  loadDaily,
  loadRings,
  loadWorkoutsByDay,
  resolveDays,
  ringFractions,
  weekStartOfAthlete,
  yearsWithData,
  type RingRow,
} from './data';
import { localParts, monthStartOf, plusDays, TZ_MARGIN_S, utcMidnight, yearStartOf } from './days';
import { listGoals } from './goals-service';
import { computeScore } from './score';
import { dailyStreak, weeklyStreak } from './streaks';

const PREFS_KEY = 'consistency.prefs';

export function getPrefs(db: Db, athleteId: number): ConsistencyPrefs {
  return { ...DEFAULT_CONSISTENCY_PREFS, ...getSetting<Partial<ConsistencyPrefs>>(db, athleteId, PREFS_KEY, {}) };
}

export function setPrefs(db: Db, athleteId: number, patch: Partial<ConsistencyPrefs>): ConsistencyPrefs {
  const next = { ...getPrefs(db, athleteId), ...patch };
  setSetting(db, athleteId, PREFS_KEY, next);
  return next;
}

/** Streaks (daily, weekly, rings) as of the data horizon. */
export function streakSummary(db: Db, athleteId: number, today?: string): StreakSummary {
  const weekStart = weekStartOfAthlete(db, athleteId);
  const days = resolveDays(db, athleteId, today);
  const active = loadActiveDays(db, athleteId);
  const rings = loadRings(db, athleteId);
  const activeSet = new Set(active);
  const closedDays = (pick: (f: ReturnType<typeof ringFractions>) => number | null) =>
    rings.filter((r) => closed(pick(ringFractions(r)))).map((r) => r.day);
  return {
    today: days.today,
    asOf: days.asOf,
    weekStart,
    daily: dailyStreak(active, days.asOf),
    weekly: weeklyStreak(active, days.asOf, weekStart, 1),
    rings: rings.length
      ? {
          move: dailyStreak(closedDays((f) => f.move), days.asOf),
          exercise: dailyStreak(closedDays((f) => f.exercise), days.asOf),
          stand: dailyStreak(closedDays((f) => f.stand), days.asOf),
        }
      : null,
    recent: Array.from({ length: 14 }, (_, i) => {
      const day = plusDays(days.asOf, i - 13);
      return { day, active: activeSet.has(day) };
    }),
  };
}

/** Same calendar date one year earlier (Feb 29 → Feb 28). */
function sameDateLastYear(day: string): string {
  const y = Number(day.slice(0, 4)) - 1;
  const md = day.slice(5) === '02-29' ? '02-28' : day.slice(5);
  return `${y}-${md}`;
}

export function overview(db: Db, athleteId: number, today?: string): ConsistencyOverview {
  const weekStart = weekStartOfAthlete(db, athleteId);
  const streaks = streakSummary(db, athleteId, today);
  const { asOf } = streaks;
  const firstDay = firstDataDay(db, athleteId);
  const prefs = getPrefs(db, athleteId);
  const active = loadActiveDays(db, athleteId);
  const count = (from: string, to: string) => active.filter((d) => d >= from && d <= to).length;
  const lastYear = sameDateLastYear(asOf);
  // 12 + 52 weeks of daily rows are enough for the score and its trend
  const rows = loadDaily(db, athleteId, plusDays(asOf, -7 * 66));
  const weeklyGoals = listGoals(db, athleteId).filter((g) => g.period === 'week');
  return {
    today: streaks.today,
    asOf,
    weekStart,
    firstDay,
    years: yearsWithData(firstDay, asOf),
    streaks,
    activeDays: {
      year: Number(asOf.slice(0, 4)),
      thisYear: count(yearStartOf(asOf), asOf),
      lastYearToDate: count(yearStartOf(lastYear), lastYear),
      thisMonth: count(monthStartOf(asOf), asOf),
      last30: count(plusDays(asOf, -29), asOf),
    },
    score: computeScore({ rows, weeklyGoals, prefs, asOf, weekStart, firstDay }),
    prefs,
  };
}

/** Per-day totals + ring fractions for [from, to] (only days with data). */
export function calendar(db: Db, athleteId: number, from: string, to: string, today?: string): CalendarResponse {
  const { asOf } = resolveDays(db, athleteId, today);
  const rows = all<{
    day: string;
    count: number;
    durationS: number;
    distanceM: number;
    elevationM: number;
    effort: number;
    energyKcal: number;
    sports: string;
  }>(
    db,
    `SELECT day, SUM(count) AS count, SUM(duration_s) AS durationS, SUM(distance_m) AS distanceM,
            SUM(elevation_m) AS elevationM, SUM(effort) AS effort, SUM(energy_kcal) AS energyKcal,
            GROUP_CONCAT(sport) AS sports
     FROM daily_activity WHERE athlete_id = ? AND day >= ? AND day <= ? AND count > 0 GROUP BY day`,
    [athleteId, from, to],
  );
  const map = new Map<string, CalendarDay>();
  for (const r of rows)
    map.set(r.day, {
      day: r.day,
      count: r.count,
      durationS: r.durationS,
      distanceM: r.distanceM,
      elevationM: r.elevationM,
      effort: r.effort,
      energyKcal: r.energyKcal,
      sports: r.sports ? r.sports.split(',') : [],
      move: null,
      exercise: null,
      stand: null,
    });
  for (const ring of loadRings(db, athleteId, from, to)) {
    const f = ringFractions(ring);
    const d = map.get(ring.day) ?? {
      day: ring.day,
      count: 0,
      durationS: 0,
      distanceM: 0,
      elevationM: 0,
      effort: 0,
      energyKcal: 0,
      sports: [],
      move: null,
      exercise: null,
      stand: null,
    };
    Object.assign(d, f);
    map.set(ring.day, d);
  }
  return {
    from,
    to,
    years: yearsWithData(firstDataDay(db, athleteId), asOf),
    days: [...map.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
  };
}

export function ringValues(r: RingRow): RingValues {
  const f = ringFractions(r);
  return {
    moveKcal: r.active_energy_kcal,
    moveGoalKcal: r.active_energy_goal_kcal,
    moveMin: (r.move_time_goal_min ?? 0) > 0 ? r.move_time_min : null,
    moveGoalMin: (r.move_time_goal_min ?? 0) > 0 ? r.move_time_goal_min : null,
    exerciseMin: r.exercise_min,
    exerciseGoalMin: r.exercise_goal_min,
    standHours: r.stand_hours,
    standGoalHours: r.stand_goal_hours,
    ...f,
  };
}

const HK = (t: string) => `HKQuantityTypeIdentifier${t}`;
const SLEEP_METRICS = ['AsleepCore', 'AsleepDeep', 'AsleepREM', 'Asleep', 'AsleepUnspecified'].map(
  (v) => `HKCategoryTypeIdentifierSleepAnalysis:${v}`,
);
const DAY_METRICS = {
  steps: HK('StepCount'),
  walkRunDistanceM: HK('DistanceWalkingRunning'),
  flights: HK('FlightsClimbed'),
  activeEnergyKcal: HK('ActiveEnergyBurned'),
  exerciseMin: HK('AppleExerciseTime'),
  restingHr: HK('RestingHeartRate'),
} as const;

/** Activities, rings and a health summary of one local day. */
export function dayDetail(db: Db, athleteId: number, day: string): DayDetail {
  const ws = all<WorkoutRow>(
    db,
    `SELECT ${SUMMARY_COLS} FROM workouts
     WHERE athlete_id = ? AND hidden = 0 AND duplicate_of IS NULL AND start_ts >= ? AND start_ts < ?
     ORDER BY start_ts, id`,
    [athleteId, utcMidnight(day) - TZ_MARGIN_S, utcMidnight(day) + 86400 + TZ_MARGIN_S],
  ).filter((w) => localDay(w.start_ts, w.tz_min) === day);
  const ring = loadRings(db, athleteId, day, day)[0];
  const metrics = [...Object.values(DAY_METRICS), ...SLEEP_METRICS];
  const values = new Map(
    all<{ metric: string; value: number }>(
      db,
      `SELECT metric, value FROM daily_metrics WHERE athlete_id = ? AND day = ? AND metric IN (${metrics.map(() => '?').join(',')})`,
      [athleteId, day, ...metrics],
    ).map((r) => [r.metric, r.value]),
  );
  const health = Object.fromEntries(
    Object.entries(DAY_METRICS).map(([k, metric]) => [k, values.get(metric) ?? null]),
  ) as unknown as DayHealth;
  const sleep = SLEEP_METRICS.reduce((s, m) => s + (values.get(m) ?? 0), 0);
  health.sleepMin = sleep > 0 ? sleep : null;
  return { day, workouts: ws.map(toSummary), rings: ring ? ringValues(ring) : null, health };
}

/** Activities per local weekday × hour (one year or all time). */
export function punchcard(db: Db, athleteId: number, year: number | null): PunchcardResponse {
  const ws = year
    ? loadWorkoutsByDay(db, athleteId, `${year}-01-01`, `${year}-12-31`)
    : loadWorkoutsByDay(db, athleteId, '1970-01-01', '9999-12-31');
  const cells = new Map<number, PunchcardCell>();
  for (const w of ws) {
    const p = localParts(w.start_ts, w.tz_min);
    const k = p.weekday * 24 + p.hour;
    const c = cells.get(k) ?? { weekday: p.weekday, hour: p.hour, count: 0, durationS: 0 };
    c.count++;
    c.durationS += w.duration_s;
    cells.set(k, c);
  }
  return {
    year,
    total: ws.length,
    cells: [...cells.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour),
  };
}
