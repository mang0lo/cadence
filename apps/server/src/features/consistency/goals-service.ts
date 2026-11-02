/**
 * Goals: CRUD on consistency_goals plus progress for the API. The goal list is mirrored into the settings
 * table (`consistency.goalsBackup`), because a data reset (POST /api/import/reset) empties every table with
 * an athlete_id column but keeps settings — the goals are restored from the mirror on the next read.
 */
import type { Goal, GoalInput, GoalMetric, GoalPeriod, GoalsResponse, GoalWithProgress } from '@cadence/shared';
import { all, get, run, tx, type Db } from '../../db/db';
import { getSetting, setSetting } from '../../core/settings';
import { firstDataDay, loadDaily, resolveDays, weekStartOfAthlete } from './data';
import { periodRange } from './days';
import {
  bucketByPeriod,
  defaultGoals,
  goalHistory,
  goalProjection,
  goalValue,
  rowsIn,
  suggestGoals,
  type DailyRow,
} from './goals';

interface GoalRow {
  id: number;
  period: string;
  sport: string | null;
  metric: string;
  target: number;
  position: number;
  created_at: number;
}

const BACKUP_KEY = 'consistency.goalsBackup';
const STATE_KEY = 'consistency.goalsState';

const toGoal = (r: GoalRow): Goal => ({
  id: r.id,
  period: r.period as GoalPeriod,
  sport: r.sport,
  metric: r.metric as GoalMetric,
  target: r.target,
  position: r.position,
  createdAt: r.created_at,
});

export function listGoals(db: Db, athleteId: number): Goal[] {
  return all<GoalRow>(
    db,
    `SELECT id, period, sport, metric, target, position, created_at FROM consistency_goals
     WHERE athlete_id = ? ORDER BY position, id`,
    [athleteId],
  ).map(toGoal);
}

export function getGoal(db: Db, athleteId: number, id: number): Goal | null {
  const r = get<GoalRow>(
    db,
    'SELECT id, period, sport, metric, target, position, created_at FROM consistency_goals WHERE athlete_id = ? AND id = ?',
    [athleteId, id],
  );
  return r ? toGoal(r) : null;
}

function writeBackup(db: Db, athleteId: number): void {
  const list = listGoals(db, athleteId).map(({ period, sport, metric, target, position }) => ({
    period,
    sport,
    metric,
    target,
    position,
  }));
  setSetting(db, athleteId, BACKUP_KEY, list);
  setSetting(db, athleteId, STATE_KEY, { seeded: true });
}

function insertGoal(db: Db, athleteId: number, g: GoalInput, position?: number): number {
  const pos =
    position ??
    (get<{ p: number | null }>(db, 'SELECT MAX(position) AS p FROM consistency_goals WHERE athlete_id = ?', [athleteId])
      ?.p ?? -1) + 1;
  return run(
    db,
    'INSERT INTO consistency_goals (athlete_id, period, sport, metric, target, position) VALUES (?, ?, ?, ?, ?, ?)',
    [athleteId, g.period, g.sport, g.metric, g.target, pos],
  ).lastInsertRowid;
}

export function createGoal(db: Db, athleteId: number, input: GoalInput): Goal {
  return tx(db, () => {
    const id = insertGoal(db, athleteId, input);
    writeBackup(db, athleteId);
    return getGoal(db, athleteId, id)!;
  });
}

export function updateGoal(db: Db, athleteId: number, id: number, patch: Partial<GoalInput>): Goal | null {
  return tx(db, () => {
    const cur = getGoal(db, athleteId, id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    run(
      db,
      `UPDATE consistency_goals SET period = ?, sport = ?, metric = ?, target = ?, updated_at = unixepoch()
       WHERE athlete_id = ? AND id = ?`,
      [next.period, next.sport, next.metric, next.target, athleteId, id],
    );
    writeBackup(db, athleteId);
    return getGoal(db, athleteId, id);
  });
}

export function deleteGoal(db: Db, athleteId: number, id: number): boolean {
  return tx(db, () => {
    const n = run(db, 'DELETE FROM consistency_goals WHERE athlete_id = ? AND id = ?', [athleteId, id]).changes;
    if (n) writeBackup(db, athleteId);
    return n > 0;
  });
}

/**
 * Goals of the athlete. When there are none: restore the mirror after a data reset, or — once, as soon as
 * there is data — seed sensible defaults derived from recent activity.
 */
export function ensureGoals(
  db: Db,
  athleteId: number,
  rows: DailyRow[],
  asOf: string,
  weekStart: 0 | 1,
  firstDay: string | null,
): Goal[] {
  const goals = listGoals(db, athleteId);
  if (goals.length) return goals;
  const backup = getSetting<(GoalInput & { position?: number })[]>(db, athleteId, BACKUP_KEY, []);
  const state = getSetting<{ seeded?: boolean }>(db, athleteId, STATE_KEY, {});
  if (backup.length) {
    tx(db, () => backup.forEach((g, i) => insertGoal(db, athleteId, g, g.position ?? i)));
  } else if (!state.seeded && firstDay) {
    tx(db, () => {
      defaultGoals(rows, asOf, weekStart, firstDay).forEach((g, i) => insertGoal(db, athleteId, g, i));
      writeBackup(db, athleteId);
    });
  } else return goals;
  return listGoals(db, athleteId);
}

/** Current progress, projection and history of one goal. */
export function goalWithProgress(
  goal: Goal,
  rows: DailyRow[],
  buckets: (period: GoalPeriod) => Map<string, DailyRow[]>,
  asOf: string,
  weekStart: 0 | 1,
  firstDay: string | null,
): GoalWithProgress {
  const { start, end } = periodRange(asOf, goal.period, weekStart);
  const value = goalValue(rowsIn(rows, start, end), goal.metric, goal.sport);
  const history = goalHistory(goal, buckets(goal.period), asOf, weekStart, firstDay);
  return {
    ...goal,
    current: goalProjection({ value, target: goal.target, start, end, asOf }),
    history,
    hitRate: history.length ? history.filter((h) => h.hit).length / history.length : null,
  };
}

/** Lazily bucketed daily rows per period. */
export function periodBuckets(rows: DailyRow[], weekStart: 0 | 1): (period: GoalPeriod) => Map<string, DailyRow[]> {
  const cache = new Map<GoalPeriod, Map<string, DailyRow[]>>();
  return (period) => {
    let b = cache.get(period);
    if (!b) cache.set(period, (b = bucketByPeriod(rows, period, weekStart)));
    return b;
  };
}

export function goalsResponse(db: Db, athleteId: number, today?: string): GoalsResponse {
  const weekStart = weekStartOfAthlete(db, athleteId);
  const days = resolveDays(db, athleteId, today);
  const firstDay = firstDataDay(db, athleteId);
  const rows = loadDaily(db, athleteId);
  const goals = ensureGoals(db, athleteId, rows, days.asOf, weekStart, firstDay);
  const buckets = periodBuckets(rows, weekStart);
  return {
    today: days.today,
    asOf: days.asOf,
    weekStart,
    goals: goals.map((g) => goalWithProgress(g, rows, buckets, days.asOf, weekStart, firstDay)),
    suggestions: suggestGoals(rows, goals, days.asOf, weekStart, firstDay),
  };
}
