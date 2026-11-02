import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DailyMetric, HealthMeta, HealthOverview, HealthSettings, HealthSnapshot } from '@cadence/shared';
import { badRequest } from '../../lib/http';
import { buildMeta, buildOverview, buildSnapshot, dailyMulti } from './overview';
import { checkDayOrder, dayParam, getHealthSettings, putHealthSettings } from './util';

const dailyQuery = z.object({
  metrics: z.string().min(1).max(2000),
  fromDay: dayParam.optional(),
  toDay: dayParam.optional(),
});

const settingsBody = z.object({ sleepGoalMin: z.number().int().min(180).max(840) }).partial();

/** Routes of the health feature, mounted under /api/health. */
export default async function healthRoutes(app: FastifyInstance) {
  app.get('/meta', async (req): Promise<HealthMeta> => buildMeta(app.db, req.athleteId));

  app.get('/overview', async (req): Promise<HealthOverview> => buildOverview(app.db, req.athleteId));

  app.get('/snapshot', async (req): Promise<HealthSnapshot> => buildSnapshot(app.db, req.athleteId));

  app.get('/settings', async (req): Promise<HealthSettings> => getHealthSettings(app.db, req.athleteId));

  app.put('/settings', async (req): Promise<HealthSettings> => {
    const body = settingsBody.parse(req.body ?? {});
    return putHealthSettings(app.db, req.athleteId, body);
  });

  // Several daily_metrics series at once (metric = identifier, or '<category identifier>:<value>')
  app.get('/daily', async (req): Promise<Record<string, DailyMetric[]>> => {
    const q = dailyQuery.parse(req.query);
    checkDayOrder(q.fromDay, q.toDay);
    const metrics = [...new Set(q.metrics.split(',').map((m) => m.trim()).filter(Boolean))];
    if (metrics.length === 0 || metrics.length > 24) throw badRequest('metrics: expected 1 to 24 comma separated metrics');
    return dailyMulti(app.db, req.athleteId, metrics, q.fromDay, q.toDay);
  });
}
