/**
 * Database loaders of the consistency feature. Everything is scoped by athlete and excludes hidden and
 * duplicate workouts (daily_activity already does). Queries hit primary keys / indexes only.
 */
import { all, get, type Db } from '../../db/db';
import { getSettings } from '../../core/settings';
import { localDay } from '../../lib/time';
import { TZ_MARGIN_S, utcMidnight } from './days';
import type { DailyRow } from './goals';

export interface RingRow {
  day: string;
  active_energy_kcal: number | null;
  active_energy_goal_kcal: number | null;
  move_time_min: number | null;
  move_time_goal_min: number | null;
  exercise_min: number | null;
  exercise_goal_min: number | null;
  stand_hours: number | null;
  stand_goal_hours: number | null;
}

export interface RingFractions {
  move: number | null;
  exercise: number | null;
  stand: number | null;
}

const frac = (v: number | null, goal: number | null): number | null =>
  v !== null && goal !== null && goal > 0 ? v / goal : null;

/** value / goal per ring. The Move ring uses minutes when a move-time goal is set (Apple's "Move time" mode). */
export function ringFractions(r: RingRow): RingFractions {
  const moveByTime = (r.move_time_goal_min ?? 0) > 0;
  return {
    move: moveByTime ? frac(r.move_time_min, r.move_time_goal_min) : frac(r.active_energy_kcal, r.active_energy_goal_kcal),
    exercise: frac(r.exercise_min, r.exercise_goal_min),
    stand: frac(r.stand_hours, r.stand_goal_hours),
  };
}

export const weekStartOfAthlete = (db: Db, athleteId: number): 0 | 1 => getSettings(db, athleteId).weekStart;

/** Workout totals per day & sport (daily_activity), optionally limited to [from, to]. */
export function loadDaily(db: Db, athleteId: number, from = '0000-01-01', to = '9999-12-31'): DailyRow[] {
  // + the longest single activity of each day and sport (single-activity goals such as "a marathon this year")
  return all<DailyRow>(
    db,
    `SELECT d.day, d.sport, d.count, d.duration_s AS durationS, d.distance_m AS distanceM, d.elevation_m AS elevationM,
            d.effort, d.energy_kcal AS energyKcal, COALESCE(l.longest, 0) AS longestM
     FROM daily_activity d
     LEFT JOIN (
       SELECT date(start_ts + tz_min * 60, 'unixepoch') AS day, sport, MAX(COALESCE(distance_m, 0)) AS longest
       FROM workouts WHERE athlete_id = ? AND hidden = 0 AND duplicate_of IS NULL
       GROUP BY 1, 2
     ) l ON l.day = d.day AND l.sport = d.sport
     WHERE d.athlete_id = ? AND d.day >= ? AND d.day <= ? ORDER BY d.day, d.sport`,
    [athleteId, athleteId, from, to],
  );
}

/** Distinct local days with at least one visible activity, ascending. */
export function loadActiveDays(db: Db, athleteId: number): string[] {
  return all<{ day: string }>(
    db,
    'SELECT DISTINCT day FROM daily_activity WHERE athlete_id = ? AND count > 0 ORDER BY day',
    [athleteId],
  ).map((r) => r.day);
}

export function loadRings(db: Db, athleteId: number, from = '0000-01-01', to = '9999-12-31'): RingRow[] {
  return all<RingRow>(
    db,
    `SELECT day, active_energy_kcal, active_energy_goal_kcal, move_time_min, move_time_goal_min, exercise_min,
            exercise_goal_min, stand_hours, stand_goal_hours
     FROM activity_summaries WHERE athlete_id = ? AND day >= ? AND day <= ? ORDER BY day`,
    [athleteId, from, to],
  );
}

export interface LiteWorkout {
  id: number;
  name: string;
  sport: string;
  start_ts: number;
  tz_min: number;
  duration_s: number;
  distance_m: number | null;
  elevation_gain_m: number | null;
}

/** Visible workouts (optionally whose start lies in [fromTs, toTs)), ordered by start. */
export function loadWorkouts(db: Db, athleteId: number, fromTs = -1e12, toTs = 1e12): LiteWorkout[] {
  return all<LiteWorkout>(
    db,
    `SELECT id, name, sport, start_ts, tz_min, duration_s, distance_m, elevation_gain_m FROM workouts
     WHERE athlete_id = ? AND hidden = 0 AND duplicate_of IS NULL AND start_ts >= ? AND start_ts < ?
     ORDER BY start_ts, id`,
    [athleteId, fromTs, toTs],
  );
}

/** Visible workouts whose LOCAL day lies in [from, to]. */
export function loadWorkoutsByDay(db: Db, athleteId: number, from: string, to: string): LiteWorkout[] {
  return loadWorkouts(db, athleteId, utcMidnight(from) - TZ_MARGIN_S, utcMidnight(to) + 86400 + TZ_MARGIN_S).filter(
    (w) => {
      const d = localDay(w.start_ts, w.tz_min);
      return d >= from && d <= to;
    },
  );
}

/**
 * The last day the data covers (every source: records of Apple Health and COROS, workouts, rings, the export date)
 * and today / asOf of a request — shared with the health feature, see core/coverage.ts.
 */
export { dataHorizon, resolveDays } from '../../core/coverage';

/** First day with an activity or ring data. */
export function firstDataDay(db: Db, athleteId: number): string | null {
  return (
    get<{ d: string | null }>(
      db,
      `SELECT MIN(d) AS d FROM (
         SELECT MIN(day) AS d FROM daily_activity WHERE athlete_id = ?
         UNION ALL SELECT MIN(day) FROM activity_summaries WHERE athlete_id = ?
       )`,
      [athleteId, athleteId],
    )?.d ?? null
  );
}

/** Contiguous years from the first data to asOf's year. */
export function yearsWithData(firstDay: string | null, asOf: string): number[] {
  const last = Number(asOf.slice(0, 4));
  const first = firstDay ? Math.min(last, Number(firstDay.slice(0, 4))) : last;
  const out: number[] = [];
  for (let y = first; y <= last; y++) out.push(y);
  return out;
}
