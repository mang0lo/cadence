import type { IntradayBucket, IntradayResponse } from '@cadence/shared';
import { all, get, type Db } from '../../db/db';
import { badRequest } from '../../lib/http';
import { parseDay } from '../../lib/time';
import { localDayRange, localDaySql, type TypeRow } from './util';

export interface IntradayRow {
  start_ts: number;
  tz_min: number;
  value: number;
  source_id: number;
}

/** Allowed bucket sizes in minutes. */
export const INTRADAY_BUCKETS = [1, 5, 10, 15, 30, 60] as const;

/**
 * Samples of one local day → buckets of `bucketS` seconds starting at `dayStartTs`.
 *  - 'avg' types: mean / min / max / count per bucket;
 *  - 'sum' types: per bucket and source the sum, then the maximum over sources (iPhone and Watch both count steps,
 *    same rule as daily_metrics) – `avg`, `min` and `max` all hold the bucket total.
 * With `dayTzMin`, a bucket whose first sample has another offset (after a DST change, while travelling) carries
 * that offset as `tzMin`, so its time can be labelled right.
 */
export function bucketize(
  rows: IntradayRow[],
  dayStartTs: number,
  dayEndTs: number,
  bucketS: number,
  aggregation: 'sum' | 'avg' | 'duration',
  dayTzMin?: number,
): IntradayBucket[] {
  const count = Math.max(1, Math.ceil((dayEndTs - dayStartTs) / bucketS));
  const idx = (ts: number) => Math.min(count - 1, Math.max(0, Math.floor((ts - dayStartTs) / bucketS)));
  const buckets = totals(rows, bucketS, aggregation, idx, dayStartTs);
  if (dayTzMin === undefined) return buckets;
  const tzOf = new Map<number, number>();
  for (const r of rows) {
    const i = idx(r.start_ts);
    if (!tzOf.has(i)) tzOf.set(i, r.tz_min);
  }
  return buckets.map((b) => {
    const tz = tzOf.get(Math.round((b.ts - dayStartTs) / bucketS));
    return tz === undefined || tz === dayTzMin ? b : { ...b, tzMin: tz };
  });
}

function totals(
  rows: IntradayRow[],
  bucketS: number,
  aggregation: 'sum' | 'avg' | 'duration',
  idx: (ts: number) => number,
  dayStartTs: number,
): IntradayBucket[] {
  if (aggregation === 'sum') {
    const per = new Map<number, Map<number, number>>();
    for (const r of rows) {
      const i = idx(r.start_ts);
      let bySource = per.get(i);
      if (!bySource) per.set(i, (bySource = new Map()));
      bySource.set(r.source_id, (bySource.get(r.source_id) ?? 0) + r.value);
    }
    return [...per.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, bySource]) => {
        const total = Math.max(...bySource.values());
        return { ts: dayStartTs + i * bucketS, avg: total, min: total, max: total, n: bySource.size };
      });
  }
  const acc = new Map<number, { sum: number; min: number; max: number; n: number }>();
  for (const r of rows) {
    const i = idx(r.start_ts);
    const a = acc.get(i);
    if (a) {
      a.sum += r.value;
      a.n++;
      if (r.value < a.min) a.min = r.value;
      if (r.value > a.max) a.max = r.value;
    } else acc.set(i, { sum: r.value, min: r.value, max: r.value, n: 1 });
  }
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, a]) => ({ ts: dayStartTs + i * bucketS, avg: a.sum / a.n, min: a.min, max: a.max, n: a.n }));
}

/**
 * Offset of the type's sample nearest to a local day without samples (the last one before it, else the first one
 * after it): the athlete's own offset rather than the server's, which may run in UTC. Null without any sample.
 */
function nearestTzMin(db: Db, athleteId: number, typeId: number, dn: number): number | null {
  const sql = (dir: 'before' | 'after') =>
    `SELECT tz_min FROM records WHERE athlete_id = ? AND type_id = ? AND start_ts ${dir === 'before' ? '<' : '>='} ?
     ORDER BY start_ts ${dir === 'before' ? 'DESC' : 'ASC'} LIMIT 1`;
  const params = [athleteId, typeId, dn * 86400];
  return (get<{ tz_min: number }>(db, sql('before'), params) ?? get<{ tz_min: number }>(db, sql('after'), params))?.tz_min ?? null;
}

/**
 * Samples of one record type on one local day, bucketed (see `bucketize`). `fallbackTzMin` is the offset used when
 * the athlete has no sample of the type at all.
 */
export function buildIntraday(
  db: Db,
  athleteId: number,
  type: TypeRow,
  day: string,
  bucketMin: number,
  fallbackTzMin: number,
): IntradayResponse {
  const dn = parseDay(day);
  if (dn === null) throw badRequest(`Invalid day ${day}`);
  // the samples of the local day, each by its own offset (offsets of samples may differ while travelling)
  const w = localDaySql('r', localDayRange(day, day));
  const rows = all<IntradayRow>(
    db,
    `SELECT r.start_ts, r.tz_min, r.value, r.source_id FROM records r
     WHERE r.athlete_id = ? AND r.type_id = ? AND ${w.sql} AND r.value IS NOT NULL ORDER BY r.start_ts`,
    [athleteId, type.id, ...w.params],
  );
  const tzMin = rows.length ? rows[0]!.tz_min : (nearestTzMin(db, athleteId, type.id, dn) ?? fallbackTzMin);
  const tzEnd = rows.length ? rows[rows.length - 1]!.tz_min : tzMin;
  const dayStartTs = dn * 86400 - tzMin * 60;
  const dayEndTs = (dn + 1) * 86400 - tzEnd * 60;
  return {
    type: type.identifier,
    day,
    unit: type.unit,
    aggregation: type.aggregation,
    tzMin,
    dayStartTs,
    dayEndTs,
    bucketS: bucketMin * 60,
    sampleCount: rows.length,
    buckets: bucketize(rows, dayStartTs, dayEndTs, bucketMin * 60, type.aggregation, tzMin),
  };
}
