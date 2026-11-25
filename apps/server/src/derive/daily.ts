import { all, get, prepare, run, tx, type Db } from '../db/db';
import type { DeriveStep } from '../features/types';
import { assignByEnd, type Aggregation } from '../import/hk';
import { dayString, localDay, parseDay } from '../lib/time';
import { asCore } from './context';

interface TypeRow {
  id: number;
  identifier: string;
  kind: string;
  aggregation: Aggregation;
}

/** Days per write transaction (keeps transactions short while the HTTP server keeps running). */
const WINDOW_DAYS = 120;
/** Latest end of a type = MAX(end_ts) of the records that start in the last week (no full scan); far longer
 * than any sleep session, the only type attributed to the day it ends. */
const END_SLACK_S = 7 * 86400;
/** record_type_stats keeps the count of records older than (last start − this) as a checkpoint, so a refresh
 * after an import of new data only counts the recent rows instead of every record of the type. */
const CHECKPOINT_LAG_S = 30 * 86400;

/** Earliest and latest start of a type's records, from the primary key (O(log n), no scan). */
function startRange(db: Db, athleteId: number, typeId: number): { lo: number; hi: number } | null {
  const lo = get<{ t: number }>(
    db,
    'SELECT start_ts AS t FROM records WHERE athlete_id = ? AND type_id = ? ORDER BY start_ts LIMIT 1',
    [athleteId, typeId],
  );
  if (!lo) return null;
  const hi = get<{ t: number }>(
    db,
    'SELECT start_ts AS t FROM records WHERE athlete_id = ? AND type_id = ? ORDER BY start_ts DESC LIMIT 1',
    [athleteId, typeId],
  )!;
  return { lo: lo.t, hi: hi.t };
}

/**
 * Recompute daily_metrics of one record type for local days >= fromDay (epoch day number, null = all):
 *  - 'sum'  (steps, energy, distance, …): per local hour take the max over sources of each source's sum
 *           (iPhone and Watch both count steps), then add up the hours.
 *  - 'avg'  (heart rate, weight, …): mean / min / max / count.
 *  - 'duration' (category types): metric '<identifier>:<value>', minutes per day, the max over sources per value;
 *           sleep is attributed to the day it ends, everything else to the day it starts.
 */
export function recomputeDailyMetrics(
  db: Db,
  athleteId: number,
  t: TypeRow,
  fromDay: number | null,
  check?: () => void,
): void {
  const range = startRange(db, athleteId, t.id);
  const metricLo = t.aggregation === 'duration' ? `${t.identifier}:` : t.identifier;
  const metricHi = t.aggregation === 'duration' ? `${t.identifier};` : t.identifier;
  const del = prepare(
    db,
    'DELETE FROM daily_metrics WHERE athlete_id = ? AND metric >= ? AND metric <= ? AND day >= ? AND day < ?',
  );
  if (!range) {
    // no records (left): drop the metrics from fromDay on
    del.run(athleteId, metricLo, metricHi, fromDay === null ? '0000' : dayString(fromDay), '9999');
    return;
  }
  const end = get<{ t: number | null }>(
    db,
    'SELECT MAX(end_ts) AS t FROM records WHERE athlete_id = ? AND type_id = ? AND start_ts >= ?',
    [athleteId, t.id, range.hi - END_SLACK_S],
  );
  const first = Math.floor(range.lo / 86400) - 1;
  const last = Math.floor(Math.max(range.hi, end?.t ?? range.hi) / 86400) + 2;
  let a = fromDay === null ? first : Math.max(fromDay, first);
  if (fromDay === null) del.run(athleteId, metricLo, metricHi, '0000', dayString(first));
  else if (fromDay < first) del.run(athleteId, metricLo, metricHi, dayString(fromDay), dayString(first));
  const byEnd = assignByEnd(t.identifier) ? 1 : 0;

  const sumSql = `INSERT INTO daily_metrics (athlete_id, metric, day, value, min, max, n)
    SELECT ?, ?, date(d * 86400, 'unixepoch'), SUM(hmax), NULL, NULL, SUM(hn) FROM (
      SELECT h / 24 AS d, MAX(s) AS hmax, n AS hn FROM (
        SELECT (start_ts + tz_min * 60) / 3600 AS h, source_id, SUM(value) AS s, COUNT(*) AS n
        FROM records WHERE athlete_id = ? AND type_id = ? AND start_ts >= ? AND start_ts < ? AND value IS NOT NULL
        GROUP BY h, source_id
      ) GROUP BY h
    ) WHERE d >= ? AND d < ? GROUP BY d`;
  const avgSql = `INSERT INTO daily_metrics (athlete_id, metric, day, value, min, max, n)
    SELECT ?, ?, date(d * 86400, 'unixepoch'), AVG(value), MIN(value), MAX(value), COUNT(*) FROM (
      SELECT (start_ts + tz_min * 60) / 86400 AS d, value
      FROM records WHERE athlete_id = ? AND type_id = ? AND start_ts >= ? AND start_ts < ? AND value IS NOT NULL
    ) WHERE d >= ? AND d < ? GROUP BY d`;
  const catSql = `INSERT INTO daily_metrics (athlete_id, metric, day, value, min, max, n)
    SELECT ?, ? || ':' || text, date(d * 86400, 'unixepoch'), MAX(mins), NULL, NULL, n FROM (
      SELECT ((CASE WHEN ${byEnd} THEN end_ts ELSE start_ts END) + tz_min * 60) / 86400 AS d, text, source_id,
             SUM(MAX(end_ts - start_ts, 0)) / 60.0 AS mins, COUNT(*) AS n
      FROM records WHERE athlete_id = ? AND type_id = ? AND start_ts >= ? AND start_ts < ? AND text IS NOT NULL
      GROUP BY d, text, source_id
    ) WHERE d >= ? AND d < ? GROUP BY d, text`;
  const sql = t.aggregation === 'sum' ? sumSql : t.aggregation === 'duration' ? catSql : avgSql;
  const ins = prepare(db, sql);
  while (a < last) {
    check?.();
    const b = Math.min(last, a + WINDOW_DAYS);
    tx(db, () => {
      del.run(athleteId, metricLo, metricHi, dayString(a), b >= last ? '9999' : dayString(b));
      ins.run(athleteId, t.identifier, athleteId, t.id, (a - 2) * 86400, (b + 2) * 86400, a, b);
    });
    a = b;
  }
}

/**
 * Count and time range of a type's records (record_type_stats). `sinceTs`: no record that starts before it was
 * added or removed since the last refresh (the earliest start of the changes) — then only the records from the
 * stored checkpoint on are counted. Without it every record of the type is counted.
 */
export function refreshTypeStats(db: Db, athleteId: number, typeId: number, sinceTs: number | null = null): void {
  const range = startRange(db, athleteId, typeId);
  if (!range) {
    run(db, 'DELETE FROM record_type_stats WHERE athlete_id = ? AND type_id = ?', [athleteId, typeId]);
    return;
  }
  let cpTs = range.hi - CHECKPOINT_LAG_S;
  const prev = get<{ cp_ts: number | null; cp_count: number | null }>(
    db,
    'SELECT cp_ts, cp_count FROM record_type_stats WHERE athlete_id = ? AND type_id = ?',
    [athleteId, typeId],
  );
  let count: number;
  let cpCount: number;
  if (sinceTs !== null && prev && prev.cp_ts !== null && prev.cp_count !== null && sinceTs >= prev.cp_ts) {
    // the records before the old checkpoint are unchanged: count the ones after it
    const r = get<{ n: number; below: number | null }>(
      db,
      `SELECT COUNT(*) AS n, SUM(start_ts < ?) AS below FROM records
       WHERE athlete_id = ? AND type_id = ? AND start_ts >= ?`,
      [cpTs, athleteId, typeId, prev.cp_ts],
    )!;
    count = prev.cp_count + r.n;
    if (cpTs >= prev.cp_ts) cpCount = prev.cp_count + (r.below ?? 0);
    else {
      cpTs = prev.cp_ts;
      cpCount = prev.cp_count;
    }
  } else {
    const r = get<{ n: number; below: number | null }>(
      db,
      'SELECT COUNT(*) AS n, SUM(start_ts < ?) AS below FROM records WHERE athlete_id = ? AND type_id = ?',
      [cpTs, athleteId, typeId],
    )!;
    count = r.n;
    cpCount = r.below ?? 0;
  }
  run(
    db,
    `INSERT INTO record_type_stats (athlete_id, type_id, count, first_ts, last_ts, cp_ts, cp_count) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (athlete_id, type_id) DO UPDATE SET count = excluded.count, first_ts = excluded.first_ts,
       last_ts = excluded.last_ts, cp_ts = excluded.cp_ts, cp_count = excluded.cp_count`,
    [athleteId, typeId, count, range.lo, range.hi, cpTs, cpCount],
  );
}

export const dailyMetricsStep: DeriveStep = {
  id: 'core.daily-metrics',
  label: 'Daily health metrics',
  weight: 3,
  run(ctx) {
    const c = asCore(ctx);
    const types = all<TypeRow>(
      ctx.db,
      'SELECT id, identifier, kind, aggregation FROM record_types ORDER BY id',
    );
    // sinceTs: no record of the type before it changed (lets refreshTypeStats count only the recent records)
    let targets: { t: TypeRow; fromDay: number | null; sinceTs: number | null }[];
    if (c.core.typeSince) {
      const byId = new Map(types.map((t) => [t.id, t]));
      targets = [...c.core.typeSince].flatMap(([id, ts]) => {
        const t = byId.get(id);
        // -1 day: local days of records near midnight / sleep that ends after midnight
        return t ? [{ t, fromDay: Math.floor(ts / 86400) - 1, sinceTs: ts }] : [];
      });
    } else {
      const from = ctx.sinceDay ? parseDay(ctx.sinceDay) : null;
      targets = types.map((t) => ({ t, fromDay: from, sinceTs: from === null ? null : (from - 1) * 86400 }));
    }
    // Biggest types last would make the progress bar stall at the end; order by identifier for stable output.
    targets.forEach(({ t, fromDay, sinceTs }, i) => {
      recomputeDailyMetrics(ctx.db, ctx.athleteId, t, fromDay, ctx.checkCancelled);
      refreshTypeStats(ctx.db, ctx.athleteId, t.id, sinceTs);
      ctx.report((i + 1) / targets.length, t.identifier.replace(/^HK\w+?TypeIdentifier/, ''));
    });
  },
};

/** Rebuild daily_activity (workout totals per local day & sport; hidden and duplicates excluded). */
export function refreshDailyActivity(db: Db, athleteId: number, day?: string): void {
  const dayExpr = "date(start_ts + tz_min * 60, 'unixepoch')";
  tx(db, () => {
    if (day) run(db, 'DELETE FROM daily_activity WHERE athlete_id = ? AND day = ?', [athleteId, day]);
    else run(db, 'DELETE FROM daily_activity WHERE athlete_id = ?', [athleteId]);
    run(
      db,
      `INSERT INTO daily_activity (athlete_id, day, sport, count, duration_s, moving_s, distance_m, elevation_m, energy_kcal, effort)
       SELECT athlete_id, ${dayExpr} AS day, sport, COUNT(*), SUM(duration_s), SUM(COALESCE(moving_s, duration_s)),
              SUM(COALESCE(distance_m, 0)), SUM(COALESCE(elevation_gain_m, 0)), SUM(COALESCE(energy_kcal, 0)), SUM(COALESCE(effort, 0))
       FROM workouts WHERE athlete_id = ? AND hidden = 0 AND duplicate_of IS NULL ${day ? `AND ${dayExpr} = ?` : ''}
       GROUP BY day, sport`,
      day ? [athleteId, day] : [athleteId],
    );
  });
}

export const dailyActivityStep: DeriveStep = {
  id: 'core.daily-activity',
  label: 'Daily activity totals',
  weight: 0.2,
  run(ctx) {
    refreshDailyActivity(ctx.db, ctx.athleteId);
    ctx.report(1);
  },
};

/** Local day of a workout row. */
export function workoutDay(w: { start_ts: number; tz_min: number }): string {
  return localDay(w.start_ts, w.tz_min);
}
