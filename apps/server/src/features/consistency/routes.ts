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
  type GoalsResponse,
  type PunchcardResponse,
  type StreakSummary,
  type TrophiesResponse,
  type YearReview,
} from '@cadence/shared';
import { badRequest, notFound } from '../../lib/http';
import { dayString, parseDay } from '../../lib/time';
import { resolveDays } from './data';
import { DAY_RE, daysBetween } from './days';
import { isFeasible, PERIOD_DAYS_MAX } from './goals';
import { createGoal, deleteGoal, getGoal, goalsResponse, updateGoal } from './goals-service';
import { calendar, dayDetail, getPrefs, overview, punchcard, setPrefs, streakSummary } from './overview';
import { trophiesResponse } from './trophies';
import { yearReview } from './year';

// lib/time parseDay accepts e.g. 2026-02-30 (only checks day ≤ 31): require a round trip
const day = z
  .string()
  .regex(DAY_RE, 'Expected YYYY-MM-DD')
  .refine((d) => {
    const e = parseDay(d);
    return e !== null && dayString(e) === d;
  }, 'Invalid day');
const todayQuery = z.object({ today: day.optional() });
const year = z.coerce.number().int().min(1970).max(2200);
const idParam = z.object({ id: z.coerce.number().int().positive() });

const calendarQuery = z
  .object({ year: year.optional(), from: day.optional(), to: day.optional(), today: day.optional() })
  .refine((q) => q.year !== undefined || (q.from !== undefined && q.to !== undefined), {
    message: 'Pass year or from + to',
  });

const punchcardQuery = z.object({ year: z.union([year, z.literal('all')]).optional() });

const goalFields = z.object({
  period: z.enum(['week', 'month', 'year']),
  sport: z
    .string()
    .refine((s) => s in SPORTS, 'Unknown sport')
    .nullable(),
  metric: z.enum(['distance', 'time', 'elevation', 'activities', 'active_days']),
  target: z.number().positive().max(1e9),
});
const feasible = {
  message: `Active days cannot exceed the days of the period (${Object.entries(PERIOD_DAYS_MAX)
    .map(([p, n]) => `${p}: ${n}`)
    .join(', ')})`,
  path: ['target'],
};
const goalBody = goalFields.refine(isFeasible, feasible);
const goalPatch = goalFields.partial();

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
    const from = q.year !== undefined ? `${q.year}-01-01` : q.from!;
    const to = q.year !== undefined ? `${q.year}-12-31` : q.to!;
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
    return goalsResponse(app.db, req.athleteId, q.today);
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
    if (!isFeasible({ ...cur, ...patch })) throw badRequest(feasible.message);
    return updateGoal(app.db, req.athleteId, id, patch)!;
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
