import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DailyMetric, HealthSample, RecordTypeInfo } from '@cadence/shared';
import { all, get } from '../db/db';
import { notFound } from '../lib/http';
import { zDay } from '../lib/params';

const dailyQuery = z.object({
  metric: z.string().min(1).max(200),
  fromDay: zDay.optional(),
  toDay: zDay.optional(),
});

const samplesQuery = z.object({
  type: z.string().min(1).max(200),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(100_000).default(1000),
  order: z.enum(['asc', 'desc']).default('asc'),
});

/** Health record endpoints, mounted under /api. */
export default async function metricsRoutes(app: FastifyInstance) {
  // Every record type the athlete has, with counts and time range (data explorer)
  app.get('/metrics/types', async (req): Promise<RecordTypeInfo[]> =>
    all<{
      id: number;
      identifier: string;
      kind: RecordTypeInfo['kind'];
      unit: string | null;
      aggregation: RecordTypeInfo['aggregation'];
      count: number;
      first_ts: number | null;
      last_ts: number | null;
    }>(
      app.db,
      `SELECT t.id, t.identifier, t.kind, t.unit, t.aggregation, s.count, s.first_ts, s.last_ts
       FROM record_type_stats s JOIN record_types t ON t.id = s.type_id
       WHERE s.athlete_id = ? ORDER BY t.identifier`,
      [req.athleteId],
    ).map((r) => ({
      id: r.id,
      identifier: r.identifier,
      kind: r.kind,
      unit: r.unit,
      aggregation: r.aggregation,
      count: r.count,
      firstTs: r.first_ts,
      lastTs: r.last_ts,
    })),
  );

  // One metric per local day. metric = record type identifier, or '<category identifier>:<value>'
  app.get('/metrics/daily', async (req): Promise<DailyMetric[]> => {
    const q = dailyQuery.parse(req.query);
    return all<DailyMetric>(
      app.db,
      `SELECT day, value, min, max, n FROM daily_metrics
       WHERE athlete_id = ? AND metric = ? AND day >= ? AND day <= ? ORDER BY day`,
      [req.athleteId, q.metric, q.fromDay ?? '0000-00-00', q.toDay ?? '9999-12-31'],
    );
  });

  // Raw samples of one type in a time range (from inclusive, to exclusive)
  app.get('/metrics/samples', async (req): Promise<HealthSample[]> => {
    const q = samplesQuery.parse(req.query);
    const t = get<{ id: number }>(app.db, 'SELECT id FROM record_types WHERE identifier = ?', [q.type]);
    if (!t) throw notFound('Record type');
    return all<HealthSample>(
      app.db,
      `SELECT r.start_ts AS startTs, r.end_ts AS endTs, r.tz_min AS tzMin, r.value, r.text, s.name AS source
       FROM records r LEFT JOIN sources s ON s.id = r.source_id
       WHERE r.athlete_id = ? AND r.type_id = ? AND r.start_ts >= ? AND r.start_ts < ?
       ORDER BY r.start_ts ${q.order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`,
      [req.athleteId, t.id, q.from ?? -1e12, q.to ?? 1e12, q.limit],
    );
  });
}
