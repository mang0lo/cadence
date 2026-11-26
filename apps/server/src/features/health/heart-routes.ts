import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HeartEvent, HeartEventType, IntradayResponse } from '@cadence/shared';
import { all } from '../../db/db';
import { badRequest } from '../../lib/http';
import { INTRADAY_BUCKETS, buildIntraday } from './intraday';
import { checkDayOrder, dayParam, localDayRange, localDaySql, resolveType } from './util';

/** Category types of heart notifications. */
const EVENT_TYPES: Record<string, HeartEventType> = {
  HKCategoryTypeIdentifierHighHeartRateEvent: 'high',
  HKCategoryTypeIdentifierLowHeartRateEvent: 'low',
  HKCategoryTypeIdentifierIrregularHeartRhythmEvent: 'irregular',
  HKCategoryTypeIdentifierLowCardioFitnessEvent: 'lowCardio',
};

const eventsQuery = z.object({
  fromDay: dayParam.optional(),
  toDay: dayParam.optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

const intradayQuery = z.object({
  type: z.string().min(1).max(200),
  day: dayParam,
  bucket: z.coerce.number().int().optional(),
});

/** "120 count/min" → 120 */
export function parseThreshold(meta: string | null): number | null {
  if (!meta) return null;
  try {
    const v = (JSON.parse(meta) as Record<string, unknown>)['HKMetadataKeyHeartRateEventThreshold'];
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseFloat(v) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function registerHeartRoutes(app: FastifyInstance): void {
  // High / low heart rate, irregular rhythm and low cardio fitness notifications, newest first
  app.get('/heart/events', async (req): Promise<HeartEvent[]> => {
    const q = eventsQuery.parse(req.query);
    checkDayOrder(q.fromDay, q.toDay);
    const types = all<{ id: number; identifier: string }>(
      app.db,
      `SELECT id, identifier FROM record_types WHERE identifier IN (${Object.keys(EVENT_TYPES).map(() => '?').join(',')})`,
      Object.keys(EVENT_TYPES),
    );
    // the exact local days in SQL, so the limit counts only events of the range
    const w = localDaySql('r', localDayRange(q.fromDay, q.toDay));
    const events: HeartEvent[] = [];
    for (const t of types) {
      const rows = all<{ start_ts: number; tz_min: number; meta: string | null; source: string | null }>(
        app.db,
        `SELECT r.start_ts, r.tz_min, r.meta, s.name AS source
         FROM records r LEFT JOIN sources s ON s.id = r.source_id
         WHERE r.athlete_id = ? AND r.type_id = ? AND ${w.sql}
         ORDER BY r.start_ts DESC LIMIT ?`,
        [req.athleteId, t.id, ...w.params, q.limit],
      );
      for (const r of rows) {
        events.push({
          type: EVENT_TYPES[t.identifier]!,
          ts: r.start_ts,
          tzMin: r.tz_min,
          threshold: parseThreshold(r.meta),
          source: r.source,
        });
      }
    }
    return events.sort((a, b) => b.ts - a.ts).slice(0, q.limit);
  });

  // Samples of one quantity type on one local day, bucketed (heart rate by 5 minutes, cumulative types by hour)
  app.get('/intraday', async (req): Promise<IntradayResponse> => {
    const q = intradayQuery.parse(req.query);
    const type = resolveType(app.db, q.type);
    if (type.kind !== 'quantity') throw badRequest('Intraday view is only available for quantity types');
    const bucket = q.bucket ?? (type.aggregation === 'sum' ? 60 : 5);
    if (!(INTRADAY_BUCKETS as readonly number[]).includes(bucket)) {
      throw badRequest(`bucket must be one of ${INTRADAY_BUCKETS.join(', ')} (minutes)`);
    }
    return buildIntraday(app.db, req.athleteId, type, q.day, bucket, -new Date().getTimezoneOffset());
  });
}
