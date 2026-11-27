/**
 * Consistency score (pure, unit-tested): the share of the last 12 complete weeks that "count" — either
 * ≥ N active days, or every weekly goal met. Weeks before the first data do not count against you.
 */
import type { ConsistencyPrefs, ConsistencyScore, GoalInput, ScoreWeek } from '@cadence/shared';
import { plusDays, weekStartOf } from './days';
import { bucketByPeriod, goalReached, goalValue, isChecked, type DailyRow } from './goals';

export const SCORE_WEEKS = 12;
export const TREND_WEEKS = 52;

export function computeScore(o: {
  rows: DailyRow[];
  /** Weekly goals; `checks` = days of the weeks checked off by hand. */
  weeklyGoals: (GoalInput & { checks?: readonly string[] })[];
  prefs: ConsistencyPrefs;
  asOf: string;
  weekStart: 0 | 1;
  firstDay: string | null;
}): ConsistencyScore {
  const goals = o.weeklyGoals.filter((g) => g.period === 'week');
  const useGoals = o.prefs.scoreBasis === 'goals' && goals.length > 0;
  const minDays = Math.max(1, Math.min(7, Math.round(o.prefs.minActiveDays)));
  const buckets = bucketByPeriod(o.rows, 'week', o.weekStart);
  const currentWeek = weekStartOf(o.asOf, o.weekStart);
  const firstWeek = o.firstDay ? weekStartOf(o.firstDay, o.weekStart) : null;

  const info = (ws: string): ScoreWeek => {
    const list = buckets.get(ws) ?? [];
    const activeDays = goalValue(list, 'active_days', null);
    const met = useGoals
      ? goals.every(
          (g) => goalReached(g.metric, goalValue(list, g.metric, g.sport), g.target) || isChecked(g.checks, ws, plusDays(ws, 6)),
        )
      : activeDays >= minDays;
    return {
      weekStart: ws,
      activeDays,
      activities: goalValue(list, 'activities', null),
      durationS: goalValue(list, 'time', null),
      met,
      inProgress: ws === currentWeek,
    };
  };
  const counts = (w: ScoreWeek) => firstWeek !== null && w.weekStart >= firstWeek;

  const span = SCORE_WEEKS + TREND_WEEKS - 1;
  const complete: ScoreWeek[] = [];
  for (let i = span; i >= 1; i--) complete.push(info(plusDays(currentWeek, -7 * i)));

  const windowScore = (end: number): { score: number | null; met: number; total: number } => {
    const win = complete.slice(Math.max(0, end - SCORE_WEEKS + 1), end + 1).filter(counts);
    const met = win.filter((w) => w.met).length;
    return { score: win.length ? met / win.length : null, met, total: win.length };
  };
  const now = windowScore(complete.length - 1);
  const trend: ConsistencyScore['trend'] = [];
  for (let i = complete.length - TREND_WEEKS; i < complete.length; i++)
    trend.push({ weekStart: complete[i]!.weekStart, score: windowScore(i).score });

  return {
    basis: useGoals ? 'goals' : 'days',
    minActiveDays: minDays,
    weeklyGoals: useGoals ? goals.length : 0,
    score: now.score,
    met: now.met,
    total: now.total,
    weeks: [...complete.slice(-SCORE_WEEKS), info(currentWeek)],
    trend,
  };
}
