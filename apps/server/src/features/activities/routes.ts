import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ActivitiesSummary, ActivityAnalysis, ActivityListPage, ActivityNav, ActivitySimilar } from '@cadence/shared';
import { getSettings } from '../../core/settings';
import { notFound } from '../../lib/http';
import { parseDay, today as serverToday } from '../../lib/time';
import { activitiesCsv } from './export';
import { activityNav, activitySummary, listActivities, similarActivities } from './queries';
import { getAnalysis } from './store';

const bool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => parseDay(d) !== null, { message: 'Invalid day' });

const summaryQuery = z.object({
  today: day.optional(),
  weekStart: z.coerce.number().int().min(0).max(1).optional(),
});

const listQuery = z.object({
  sport: z.string().max(500).optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  q: z.string().max(200).optional(),
  hasRoute: bool.optional(),
  includeHidden: bool.optional(),
  sort: z.enum(['start', 'distance', 'time', 'pace', 'elevation', 'hr', 'effort']).default('start'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const exportQuery = listQuery.omit({ limit: true, offset: true }).extend({
  lang: z.enum(['en', 'de']).default('en'),
  units: z.enum(['metric', 'imperial']).optional(),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

const similarQuery = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(250) });

/** Routes of the activities feature, mounted under /api/activities. */
export default async function activitiesRoutes(app: FastifyInstance) {
  app.get('/summary', async (req): Promise<ActivitiesSummary> => {
    const q = summaryQuery.parse(req.query);
    const weekStart = (q.weekStart ?? getSettings(app.db, req.athleteId).weekStart) as 0 | 1;
    return activitySummary(app.db, req.athleteId, q.today ?? serverToday(), weekStart);
  });

  app.get('/list', async (req): Promise<ActivityListPage> => {
    const q = listQuery.parse(req.query);
    return listActivities(app.db, req.athleteId, q);
  });

  // Every activity matching the list filters as a spreadsheet (attachment → the Mac app saves it to Downloads)
  app.get('/export.csv', async (req, reply) => {
    const q = exportQuery.parse(req.query);
    const units = q.units ?? getSettings(app.db, req.athleteId).units;
    const csv = activitiesCsv(app.db, req.athleteId, { ...q, units });
    const file = `cadence-${q.lang === 'de' ? 'aktivitaeten' : 'activities'}-${serverToday()}.csv`;
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${file}"`)
      .send(csv);
  });

  app.get('/:id/nav', async (req): Promise<ActivityNav> => {
    const { id } = idParam.parse(req.params);
    const nav = activityNav(app.db, req.athleteId, id);
    if (!nav) throw notFound('Workout');
    return nav;
  });

  app.get('/:id/analysis', async (req): Promise<ActivityAnalysis> => {
    const { id } = idParam.parse(req.params);
    const a = getAnalysis(app.db, req.athleteId, id);
    if (!a) throw notFound('Workout');
    return a;
  });

  app.get('/:id/similar', async (req): Promise<ActivitySimilar> => {
    const { id } = idParam.parse(req.params);
    const { limit } = similarQuery.parse(req.query);
    const s = similarActivities(app.db, req.athleteId, id, limit);
    if (!s) throw notFound('Workout');
    return s;
  });
}
