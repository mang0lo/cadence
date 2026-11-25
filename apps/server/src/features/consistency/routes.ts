/** /api/consistency — streaks, calendar, goals, trophies and year in review. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  SPORTS,
  type CalendarResponse,
  type ConsistencyOverview,
  type ConsistencyPrefs,
  type DayDetail,
  type Goal,
  type GoalCheckResult,
  type GoalsResponse,
  type PunchcardResponse,
  type StreakSummary,
  type TrophiesResponse,
  type YearReview,
} from '@cadence/shared';
import { badRequest, notFound } from '../../lib/http';
import { parseDay } from '../../lib/time';
import { resolveDays, weekStartOfAthlete } from './data';
import { DAY_RE, daysBetween, plusDays, weekStartOf } from './days';
import { isFeasible, metricFits, PERIOD_DAYS_MAX } from './goals';
import { createGoal, deleteGoal, getGoal, goalsResponse, setGoalCheck, updateGoal } from './goals-service';
import { calendar, dayDetail, getPrefs, overview, punchcard, setPrefs, streakSummary } from './overview';
import { trophiesResponse } from './trophies';
import { yearReview } from './year';

// a day of the calendar (lib/time parseDay rejects 2026-02-30)
const day = z
  .string()
  .regex(DAY_RE, 'Expected YYYY-MM-DD')
  .refine((d) => parseDay(d) !== null, 'Invalid day');
const todayQuery = z.object({ today: day.optional() });
const year = z.coerce.number().int().min(1970).max(2200);
const idParam = z.object({ id: z.coerce.number().int().positive() });

const calendarQuery = z
  .object({
    year: year.optional(),
    from: day.optional(),
    to: day.optional(),
    /** The last N weeks (by the athlete's week start) up to asOf. */
    weeks: z.coerce.number().int().min(1).max(110).optional(),
    today: day.optional(),
  })
  .refine((q) => q.year !== undefined || q.weeks !== undefined || (q.from !== undefined && q.to !== undefined), {
    message: 'Pass year, weeks or from + to',
  });

const punchcardQuery = z.object({ year: z.union([year, z.literal('all')]).optional() });

const goalFields = z.object({
  period: z.enum(['day', 'week', 'month', 'year']),
  sport: z
    .string()
    .refine((s) => Object.hasOwn(SPORTS, s), 'Unknown sport')
    .nullable(),
  metric: z.enum(['distance', 'longest', 'time', 'elevation', 'calories', 'activities', 'active_days']),
  target: z.number().positive().max(1e9),
});
const feasible = {
  message: `Active days cannot exceed the days of the period (${Object.entries(PERIOD_DAYS_MAX)
    .map(([p, n]) => `${p}: ${n}`)
    .join(', ')})`,
  path: ['target'],
};
const fits = { message: 'This measure does not exist for the sport or period', path: ['metric'] };
const goalBody = goalFields.refine(metricFits, fits).refine(isFeasible, feasible);
const goalPatch = goalFields.partial();
const checkBody = z.object({
  /** A day of the period to check off; default: the current period (today for daily goals). */
  day: day.optional(),
  done: z.boolean(),
  today: day.optional(),
});

const prefsBody = z
  .object({
    scoreBasis: z.enum(['days', 'goals']),
    minActiveDays: z.number().int().min(1).max(7),
  })
  .partial();

export default async function consistencyRoutes(app: FastifyInstance) {
  app.get('/overview', async (req): Promise<ConsistencyOverview> => {
    const q = todayQuery.parse(req.query);
    return overview(app.db, req.athleteId, q.today);
  });

  app.get('/streaks', async (req): Promise<StreakSummary> => {
    const q = todayQuery.parse(req.query);
    return streakSummary(app.db, req.athleteId, q.today);
  });

  app.get('/calendar', async (req): Promise<CalendarResponse> => {
    const q = calendarQuery.parse(req.query);
    let from: string;
    let to: string;
    if (q.year !== undefined) {
      from = `${q.year}-01-01`;
      to = `${q.year}-12-31`;
    } else if (q.weeks !== undefined) {
      to = resolveDays(app.db, req.athleteId, q.today).asOf;
      from = plusDays(weekStartOf(to, weekStartOfAthlete(app.db, req.athleteId)), -7 * (q.weeks - 1));
    } else {
      from = q.from!;
      to = q.to!;
    }
    if (from > to) throw badRequest('from must not be after to');
    if (daysBetween(from, to) > 800) throw badRequest('Range too long (max 800 days)');
    return calendar(app.db, req.athleteId, from, to, q.today);
  });

  app.get('/day/:day', async (req): Promise<DayDetail> => {
    const p = z.object({ day }).parse(req.params);
    return dayDetail(app.db, req.athleteId, p.day);
  });

  app.get('/punchcard', async (req): Promise<PunchcardResponse> => {
    const q = punchcardQuery.parse(req.query);
    return punchcard(app.db, req.athleteId, q.year === undefined || q.year === 'all' ? null : q.year);
  });

  app.get('/prefs', async (req): Promise<ConsistencyPrefs> => getPrefs(app.db, req.athleteId));

  app.put('/prefs', async (req): Promise<ConsistencyPrefs> => {
    const body = prefsBody.parse(req.body ?? {});
    return setPrefs(app.db, req.athleteId, body);
  });

  app.get('/goals', async (req): Promise<GoalsResponse> => {
    const q = todayQuery.parse(req.query);
    // the starting goals come from the daily totals, which the import writes last: not while one is running
    return goalsResponse(app.db, req.athleteId, q.today, { seed: !app.jobs.busy(req.athleteId) });
  });

  app.post('/goals', async (req, reply): Promise<Goal> => {
    const body = goalBody.parse(req.body ?? {});
    reply.code(201);
    return createGoal(app.db, req.athleteId, body);
  });

  app.patch('/goals/:id', async (req): Promise<Goal> => {
    const { id } = idParam.parse(req.params);
    const patch = goalPatch.parse(req.body ?? {});
    const cur = getGoal(app.db, req.athleteId, id);
    if (!cur) throw notFound('Goal');
    if (!metricFits({ ...cur, ...patch })) throw badRequest(fits.message);
    if (!isFeasible({ ...cur, ...patch })) throw badRequest(feasible.message);
    return updateGoal(app.db, req.athleteId, id, patch)!;
  });

  /** Check a goal off by hand for one period (something was done but not tracked), or take the check mark back. */
  app.put('/goals/:id/check', async (req): Promise<GoalCheckResult> => {
    const { id } = idParam.parse(req.params);
    const body = checkBody.parse(req.body ?? {});
    const goal = getGoal(app.db, req.athleteId, id);
    if (!goal) throw notFound('Goal');
    const days = resolveDays(app.db, req.athleteId, body.today);
    // a daily goal is about the real today, the others about the last day the data covers (like the goal cards)
    const current = goal.period === 'day' ? days.today : days.asOf;
    const target = body.day ?? current;
    if (target > days.today) throw badRequest('A goal cannot be checked off for the future');
    return setGoalCheck(app.db, req.athleteId, id, target, body.done)!;
  });

  app.delete('/goals/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    if (!deleteGoal(app.db, req.athleteId, id)) throw notFound('Goal');
    return { ok: true };
  });

  app.get('/trophies', async (req): Promise<TrophiesResponse> => {
    const q = todayQuery.parse(req.query);
    return trophiesResponse(app.db, req.athleteId, q.today);
  });

  app.get('/year/:year', async (req): Promise<YearReview> => {
    const p = z.object({ year }).parse(req.params);
    const q = todayQuery.parse(req.query);
    return yearReview(app.db, req.athleteId, p.year, q.today);
  });

  /** The year the year-in-review page opens with (the latest year with data). */
  app.get('/year', async (req): Promise<YearReview> => {
    const q = todayQuery.parse(req.query);
    const { asOf } = resolveDays(app.db, req.athleteId, q.today);
    return yearReview(app.db, req.athleteId, Number(asOf.slice(0, 4)), q.today);
  });
}
