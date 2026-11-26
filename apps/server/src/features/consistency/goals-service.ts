/**
 * Goals: CRUD on consistency_goals plus progress for the API, and the check marks set by hand
 * (consistency_goal_checks). Both tables survive a data reset (Feature.keepOnReset); the goal list is additionally
 * mirrored into the settings table (`consistency.goalsBackup`) and restored from there on the next read if the
 * table is ever found empty (e.g. after an older reset).
 */
import type { Goal, GoalInput, GoalMetric, GoalPeriod, GoalsResponse, GoalWithProgress } from '@cadence/shared';
import { all, get, run, tx, type Db } from '../../db/db';
import { getSetting, getSettings, setSetting } from '../../core/settings';
import { firstDataDay, loadDaily, resolveDays, weekStartOfAthlete } from './data';
import { periodRange, plusDays } from './days';
import {
  bucketByPeriod,
  defaultGoals,
  goalHistory,
  goalProjection,
  goalValue,
  isChecked,
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

/** Days of the check marks per goal id, ascending. */
export function loadChecks(db: Db, athleteId: number): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const r of all<{ goal_id: number; day: string }>(
    db,
    `SELECT c.goal_id, c.day FROM consistency_goal_checks c JOIN consistency_goals g ON g.id = c.goal_id
     WHERE g.athlete_id = ? ORDER BY c.goal_id, c.day`,
    [athleteId],
  )) {
    let list = out.get(r.goal_id);
    if (!list) out.set(r.goal_id, (list = []));
    list.push(r.day);
  }
  return out;
}

/**
 * Check a goal off by hand for the period containing `day` (or remove the check mark). Returns the period, or null
 * when the goal does not exist. The mark is stored on the first day of the period, for weeks on its middle (the
 * fourth day): that day lies in the week the mark was set for with either week start (Sunday or Monday).
 */
export function setGoalCheck(
  db: Db,
  athleteId: number,
  id: number,
  day: string,
  done: boolean,
): { start: string; end: string; done: boolean } | null {
  return tx(db, () => {
    const goal = getGoal(db, athleteId, id);
    if (!goal) return null;
    const { start, end } = periodRange(day, goal.period, weekStartOfAthlete(db, athleteId));
    run(db, 'DELETE FROM consistency_goal_checks WHERE goal_id = ? AND day >= ? AND day <= ?', [id, start, end]);
    if (done)
      run(db, 'INSERT INTO consistency_goal_checks (goal_id, day) VALUES (?, ?)', [
        id,
        goal.period === 'week' ? plusDays(start, 3) : start,
      ]);
    writeBackup(db, athleteId);
    return { start, end, done };
  });
}

function writeBackup(db: Db, athleteId: number): void {
  const checks = loadChecks(db, athleteId);
  const list = listGoals(db, athleteId).map(({ id, period, sport, metric, target, position }) => ({
    period,
    sport,
    metric,
    target,
    position,
    ...(checks.has(id) ? { checks: checks.get(id) } : {}),
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
    // check marks belong to periods: a daily goal turned into a weekly one starts without them
    if (next.period !== cur.period) run(db, 'DELETE FROM consistency_goal_checks WHERE goal_id = ?', [id]);
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
    run(
      db,
      'DELETE FROM consistency_goal_checks WHERE goal_id IN (SELECT id FROM consistency_goals WHERE athlete_id = ? AND id = ?)',
      [athleteId, id],
    );
    const n = run(db, 'DELETE FROM consistency_goals WHERE athlete_id = ? AND id = ?', [athleteId, id]).changes;
    if (n) writeBackup(db, athleteId);
    return n > 0;
  });
}

/**
 * Goals of the athlete. When there are none: restore the mirror after a data reset, or — once, as soon as
 * there is data — seed sensible defaults derived from recent activity. `seed: false` (an import or sync is still
 * running, so the daily totals may be missing) postpones the seeding to a later call.
 */
export function ensureGoals(
  db: Db,
  athleteId: number,
  rows: DailyRow[],
  asOf: string,
  weekStart: 0 | 1,
  firstDay: string | null,
  seed = true,
): Goal[] {
  const goals = listGoals(db, athleteId);
  if (goals.length) return goals;
  const backup = getSetting<(GoalInput & { position?: number; checks?: string[] })[]>(db, athleteId, BACKUP_KEY, []);
  const state = getSetting<{ seeded?: boolean }>(db, athleteId, STATE_KEY, {});
  if (backup.length) {
    tx(db, () =>
      backup.forEach((g, i) => {
        const id = insertGoal(db, athleteId, g, g.position ?? i);
        for (const day of new Set(g.checks ?? []))
          run(db, 'INSERT INTO consistency_goal_checks (goal_id, day) VALUES (?, ?)', [id, day]);
      }),
    );
  } else if (seed && !state.seeded && firstDay) {
    tx(db, () => {
      const units = getSettings(db, athleteId).units;
      defaultGoals(rows, asOf, weekStart, firstDay, units).forEach((g, i) => insertGoal(db, athleteId, g, i));
      writeBackup(db, athleteId);
    });
  } else return goals;
  return listGoals(db, athleteId);
}

/**
 * Current progress, projection and history of one goal. Weekly, monthly and yearly goals are judged as of the last
 * day the data covers (`asOf`). A daily goal is about the real `today`: it can be checked off before the next import,
 * and earlier days the data does not cover yet are pending rather than missed.
 */
export function goalWithProgress(
  goal: Goal,
  rows: DailyRow[],
  buckets: (period: GoalPeriod) => Map<string, DailyRow[]>,
  asOf: string,
  weekStart: 0 | 1,
  firstDay: string | null,
  o: { checks?: readonly string[]; today?: string } = {},
): GoalWithProgress {
  const daily = goal.period === 'day';
  const ref = daily && o.today && o.today > asOf ? o.today : asOf;
  const { start, end } = periodRange(ref, goal.period, weekStart);
  const value = goalValue(rowsIn(rows, start, end), goal.metric, goal.sport);
  const history = goalHistory(goal, buckets(goal.period), ref, weekStart, firstDay, { checks: o.checks, horizon: asOf });
  const judged = history.filter((h) => !h.pending);
  return {
    ...goal,
    current: goalProjection({
      value,
      target: goal.target,
      start,
      end,
      asOf: ref,
      single: daily || goal.metric === 'longest',
      checked: isChecked(o.checks, start, end),
    }),
    history,
    hitRate: judged.length ? judged.filter((h) => h.hit).length / judged.length : null,
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

/** `seed`: whether default goals may be seeded now (see ensureGoals). */
export function goalsResponse(db: Db, athleteId: number, today?: string, o: { seed?: boolean } = {}): GoalsResponse {
  const weekStart = weekStartOfAthlete(db, athleteId);
  const days = resolveDays(db, athleteId, today);
  const firstDay = firstDataDay(db, athleteId);
  const rows = loadDaily(db, athleteId);
  const goals = ensureGoals(db, athleteId, rows, days.asOf, weekStart, firstDay, o.seed ?? true);
  const buckets = periodBuckets(rows, weekStart);
  const checks = loadChecks(db, athleteId);
  return {
    today: days.today,
    asOf: days.asOf,
    weekStart,
    goals: goals.map((g) =>
      goalWithProgress(g, rows, buckets, days.asOf, weekStart, firstDay, { checks: checks.get(g.id), today: days.today }),
    ),
    suggestions: suggestGoals(rows, goals, days.asOf, weekStart, firstDay, undefined, getSettings(db, athleteId).units),
  };
}
