import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  ExplorerResponse,
  MetricCategorySeries,
  MetricSample,
  MetricSeries,
  MetricSourceRow,
  MetricSources,
  Page,
  RecordTypeInfo,
} from '@cadence/shared';
import { all, get, type Db } from '../../db/db';
import { getSettings } from '../../core/settings';
import { buildExplorer } from './explorer';
import { SOURCE_NAMES, sourcesStamp, storedSourceGroups, type SourceGroupRow } from './record-sources';
import { aggregatePoints, combineCategoryRows, summarize, withoutDuplicateSleep, type DailyRow } from './series';
import { checkDayOrder, dayParam, localDayRange, localDaySql, resolveType, type TypeRow } from './util';

const seriesQuery = z.object({
  type: z.string().min(1).max(200),
  fromDay: dayParam.optional(),
  toDay: dayParam.optional(),
  agg: z.enum(['day', 'week', 'month']).default('day'),
});

const rangeQuery = z.object({
  type: z.string().min(1).max(200),
  fromDay: dayParam.optional(),
  toDay: dayParam.optional(),
});

const samplesQuery = z.object({
  type: z.string().min(1).max(200),
  fromDay: dayParam.optional(),
  toDay: dayParam.optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
  order: z.enum(['asc', 'desc']).default('desc'),
});

function typeInfo(db: Db, athleteId: number, t: TypeRow): RecordTypeInfo {
  const s = get<{ count: number; first_ts: number | null; last_ts: number | null }>(
    db,
    'SELECT count, first_ts, last_ts FROM record_type_stats WHERE athlete_id = ? AND type_id = ?',
    [athleteId, t.id],
  );
  return {
    id: t.id,
    identifier: t.identifier,
    kind: t.kind,
    unit: t.unit,
    aggregation: t.aggregation,
    count: s?.count ?? 0,
    firstTs: s?.first_ts ?? null,
    lastTs: s?.last_ts ?? null,
  };
}

/**
 * WHERE clause on `records r` for one type and a range: the UTC window of the local days (narrowed by `from` / `to`)
 * for the primary key, plus the exact local days as integer arithmetic (only when days are given).
 */
function recordWhere(
  athleteId: number,
  typeId: number,
  o: { fromDay?: string; toDay?: string; from?: number; to?: number },
): { sql: string; params: number[] } {
  const days = localDayRange(o.fromDay, o.toDay);
  const w = localDaySql('r', {
    ...days,
    lo: o.from === undefined ? days.lo : Math.max(o.from, days.lo),
    hi: o.to === undefined ? days.hi : Math.min(o.to, days.hi),
  });
  return { sql: `r.athlete_id = ? AND r.type_id = ? AND ${w.sql}`, params: [athleteId, typeId, ...w.params] };
}

/**
 * Sample count and newest sample of a type (record_type_stats, refreshed when an import or sync changes the type):
 * answers computed from its records stay valid while this stamp is unchanged.
 */
function typeStamp(db: Db, athleteId: number, typeId: number): { count: number; stamp: string } {
  const s = get<{ count: number; last_ts: number | null }>(
    db,
    'SELECT count, last_ts FROM record_type_stats WHERE athlete_id = ? AND type_id = ?',
    [athleteId, typeId],
  );
  return { count: s?.count ?? 0, stamp: sourcesStamp(s?.count, s?.last_ts) };
}

/** /metric/sources answers per athlete, type and range, validated against the type's stamp. */
const sourcesCache = new Map<string, { stamp: string; value: MetricSources }>();
/** Sample counts of ranged /metric/samples requests (every page of a range needs it), validated the same way. */
const totalsCache = new Map<string, { stamp: string; total: number }>();

export function registerMetricRoutes(app: FastifyInstance): void {
  app.get('/explorer', async (req): Promise<ExplorerResponse> => buildExplorer(app.db, req.athleteId));

  // One record type aggregated per day / week / month from daily_metrics (+ statistics of the range)
  app.get('/metric/series', async (req): Promise<MetricSeries> => {
    const q = seriesQuery.parse(req.query);
    checkDayOrder(q.fromDay, q.toDay);
    const t = resolveType(app.db, q.type);
    const weekStart = getSettings(app.db, req.athleteId).weekStart;
    const from = q.fromDay ?? '0000-00-00';
    const to = q.toDay ?? '9999-12-31';
    const base = { type: typeInfo(app.db, req.athleteId, t), agg: q.agg, fromDay: q.fromDay ?? null, toDay: q.toDay ?? null };

    if (t.aggregation === 'duration') {
      const rows = all<{ metric: string; day: string; value: number; n: number }>(
        app.db,
        `SELECT metric, day, value, n FROM daily_metrics
         WHERE athlete_id = ? AND metric >= ? AND metric < ? AND day >= ? AND day <= ? ORDER BY day`,
        [req.athleteId, `${t.identifier}:`, `${t.identifier};`, from, to],
      );
      const raw = new Map<string, DailyRow[]>();
      for (const r of rows) {
        const value = r.metric.slice(t.identifier.length + 1);
        const arr = raw.get(value) ?? [];
        arr.push({ day: r.day, value: r.value, min: null, max: null, n: r.n });
        raw.set(value, arr);
      }
      // a night written by the watch (stages) and by a second app (generic Asleep) is stacked once, like it is counted
      const byValue = withoutDuplicateSleep(raw, t.identifier);
      const categories: MetricCategorySeries[] = [...byValue.entries()]
        .map(([value, rs]) => ({
          value,
          total: rs.reduce((s, r) => s + r.value, 0),
          points: aggregatePoints(rs, q.agg, weekStart, 'duration'),
        }))
        .sort((a, b) => b.total - a.total || a.value.localeCompare(b.value));
      const combined = combineCategoryRows(byValue, t.identifier);
      return {
        ...base,
        points: aggregatePoints(combined, q.agg, weekStart, 'duration'),
        categories,
        stats: summarize(combined, 'duration'),
      };
    }

    const rows = all<DailyRow>(
      app.db,
      `SELECT day, value, min, max, n FROM daily_metrics
       WHERE athlete_id = ? AND metric = ? AND day >= ? AND day <= ? ORDER BY day`,
      [req.athleteId, t.identifier, from, to],
    );
    return {
      ...base,
      points: aggregatePoints(rows, q.agg, weekStart, t.aggregation),
      categories: [],
      stats: summarize(rows, t.aggregation),
    };
  });

  // Which sources / devices wrote the samples of a type (in a range)
  app.get('/metric/sources', async (req): Promise<MetricSources> => {
    const q = rangeQuery.parse(req.query);
    checkDayOrder(q.fromDay, q.toDay);
    const t = resolveType(app.db, q.type);
    const w = recordWhere(req.athleteId, t.id, q);
    // Millions of samples for heart rate: the answer only changes with an import, so it is kept per type and range
    // (validated against the type's sample count and newest sample).
    const { stamp } = typeStamp(app.db, req.athleteId, t.id);
    const cacheKey = `${req.athleteId}|${t.id}|${q.fromDay ?? ''}|${q.toDay ?? ''}`;
    const cached = sourcesCache.get(cacheKey);
    if (cached && cached.stamp === stamp) return cached.value;
    // the whole history is counted by the derive step (health.record-sources) while the type is unchanged; else group
    // on the two integer ids first, then name the few groups (joining and concatenating per sample is slow)
    const rows =
      (!q.fromDay && !q.toDay ? storedSourceGroups(app.db, req.athleteId, t.id, stamp) : null) ??
      all<SourceGroupRow>(
        app.db,
        `SELECT g.source_id, ${SOURCE_NAMES}, g.n, g.first_ts, g.last_ts
         FROM (
           SELECT r.source_id, r.device_id, COUNT(*) AS n, MIN(r.start_ts) AS first_ts, MAX(r.start_ts) AS last_ts
           FROM records r WHERE ${w.sql} GROUP BY r.source_id, r.device_id
         ) g LEFT JOIN sources s ON s.id = g.source_id LEFT JOIN devices d ON d.id = g.device_id`,
        w.params,
      );
    const by = new Map<number, MetricSourceRow & { devSet: Set<string> }>();
    for (const r of rows) {
      let s = by.get(r.source_id);
      if (!s) {
        s = { sourceId: r.source_id, name: r.name ?? '–', count: 0, firstTs: r.first_ts, lastTs: r.last_ts, devices: [], devSet: new Set() };
        by.set(r.source_id, s);
      }
      s.count += r.n;
      s.firstTs = Math.min(s.firstTs, r.first_ts);
      s.lastTs = Math.max(s.lastTs, r.last_ts);
      const dev = (r.device ?? '').trim();
      if (dev) s.devSet.add(dev);
    }
    const sources = [...by.values()]
      .map(({ devSet, ...s }) => ({ ...s, devices: [...devSet].sort() }))
      .sort((a, b) => b.count - a.count);
    const value: MetricSources = { type: t.identifier, total: sources.reduce((n, s) => n + s.count, 0), sources };
    if (sourcesCache.size >= 200) sourcesCache.clear();
    sourcesCache.set(cacheKey, { stamp, value });
    return value;
  });

  // Raw samples, paginated
  app.get('/metric/samples', async (req): Promise<Page<MetricSample>> => {
    const q = samplesQuery.parse(req.query);
    checkDayOrder(q.fromDay, q.toDay);
    const t = resolveType(app.db, q.type);
    const w = recordWhere(req.athleteId, t.id, q);
    const unbounded = q.from === undefined && q.to === undefined && !q.fromDay && !q.toDay;
    // the whole history is already counted in record_type_stats, a range is counted once for all its pages (a COUNT(*)
    // over a year of heart rate blocks the event loop for every page otherwise)
    const { count, stamp } = typeStamp(app.db, req.athleteId, t.id);
    let total = count;
    if (!unbounded) {
      const key = `${req.athleteId}|${t.id}|${q.fromDay ?? ''}|${q.toDay ?? ''}|${q.from ?? ''}|${q.to ?? ''}`;
      const cached = totalsCache.get(key);
      if (cached && cached.stamp === stamp) total = cached.total;
      else {
        total = get<{ n: number }>(app.db, `SELECT COUNT(*) AS n FROM records r WHERE ${w.sql}`, w.params)?.n ?? 0;
        if (totalsCache.size >= 200) totalsCache.clear();
        totalsCache.set(key, { stamp, total });
      }
    }
    const items = all<MetricSample>(
      app.db,
      `SELECT r.start_ts AS startTs, r.end_ts AS endTs, r.tz_min AS tzMin, r.value, r.text, s.name AS source,
              CASE WHEN d.id IS NULL THEN NULL ELSE COALESCE(d.name, d.model, '') || CASE WHEN d.hardware IS NULL THEN '' ELSE ' (' || d.hardware || ')' END END AS device
       FROM records r LEFT JOIN sources s ON s.id = r.source_id LEFT JOIN devices d ON d.id = r.device_id
       WHERE ${w.sql}
       ORDER BY r.start_ts ${q.order === 'asc' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`,
      [...w.params, q.limit, q.offset],
    );
    return { items, total, limit: q.limit, offset: q.offset };
  });
}
