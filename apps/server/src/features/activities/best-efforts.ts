import { all, type Db } from '../../db/db';

/*
 * Rank of a best effort: among the athlete's visible workouts (not hidden, no duplicates) of the same sport and
 * effort, by elapsed time; ties → the earlier workout, then the lower id, so an older attempt keeps its record
 * whatever the import order. One rule for medals, recent PRs and Progress → Records.
 */

export interface RankedEffort {
  workout_id: number;
  effort: string;
  distance_m: number;
  elapsed_s: number;
  start_ts: number;
  tz_min: number;
}

type EffortKey = Pick<RankedEffort, 'elapsed_s' | 'start_ts' | 'workout_id'>;

/** The ranking rule as a comparator (better first) for efforts of one sport and effort. */
export function compareEfforts(a: EffortKey, b: EffortKey): number {
  return a.elapsed_s - b.elapsed_s || a.start_ts - b.start_ts || a.workout_id - b.workout_id;
}

/**
 * The `n` best efforts of a sport and effort among visible workouts, best first. Walks ix_best_efforts (athlete,
 * sport, effort, elapsed time) and stops after `n`, instead of ranking every effort.
 */
export function topEfforts(db: Db, athleteId: number, sport: string, effort: string, n: number): RankedEffort[] {
  return all<RankedEffort>(
    db,
    `SELECT be.workout_id, be.effort, be.distance_m, be.elapsed_s, be.start_ts, w.tz_min
     FROM best_efforts be JOIN workouts w ON w.id = be.workout_id
     WHERE be.athlete_id = ? AND be.sport = ? AND be.effort = ? AND w.hidden = 0 AND w.duplicate_of IS NULL
     ORDER BY be.elapsed_s, be.start_ts, be.workout_id LIMIT ?`,
    [athleteId, sport, effort, n],
  );
}
