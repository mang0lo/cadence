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
  const range = get<{ lo: number | null; hi: number | null }>(
    db,
    'SELECT MIN(start_ts) AS lo, MAX(end_ts) AS hi FROM records WHERE athlete_id = ? AND type_id = ?',
    [athleteId, t.id],
  );
  const metricLo = t.aggregation === 'duration' ? `${t.identifier}:` : t.identifier;
  const metricHi = t.aggregation === 'duration' ? `${t.identifier};` : t.identifier;
  const del = prepare(
    db,
    'DELETE FROM daily_metrics WHERE athlete_id = ? AND metric >= ? AND metric <= ? AND day >= ? AND day < ?',
  );
  if (range?.lo === null || range?.lo === undefined) {
    // no records (left): drop the metrics from fromDay on
    del.run(athleteId, metricLo, metricHi, fromDay === null ? '0000' : dayString(fromDay), '9999');
    return;
  }
  const first = Math.floor(range.lo / 86400) - 1;
  const last = Math.floor(range.hi! / 86400) + 2;
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

export function refreshTypeStats(db: Db, athleteId: number, typeId: number): void {
  const r = get<{ n: number; lo: number | null; hi: number | null }>(
    db,
    'SELECT COUNT(*) AS n, MIN(start_ts) AS lo, MAX(start_ts) AS hi FROM records WHERE athlete_id = ? AND type_id = ?',
    [athleteId, typeId],
  )!;
  if (!r.n)
    run(db, 'DELETE FROM record_type_stats WHERE athlete_id = ? AND type_id = ?', [athleteId, typeId]);
  else
    run(
      db,
      `INSERT INTO record_type_stats (athlete_id, type_id, count, first_ts, last_ts) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (athlete_id, type_id) DO UPDATE SET count = excluded.count, first_ts = excluded.first_ts, last_ts = excluded.last_ts`,
      [athleteId, typeId, r.n, r.lo, r.hi],
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
    let targets: { t: TypeRow; fromDay: number | null }[];
    if (c.core.typeSince) {
      const byId = new Map(types.map((t) => [t.id, t]));
      targets = [...c.core.typeSince].flatMap(([id, ts]) => {
        const t = byId.get(id);
        // -1 day: local days of records near midnight / sleep that ends after midnight
        return t ? [{ t, fromDay: Math.floor(ts / 86400) - 1 }] : [];
      });
    } else {
      const from = ctx.sinceDay ? parseDay(ctx.sinceDay) : null;
      targets = types.map((t) => ({ t, fromDay: from }));
    }
    // Biggest types last would make the progress bar stall at the end; order by identifier for stable output.
    targets.forEach(({ t, fromDay }, i) => {
      recomputeDailyMetrics(ctx.db, ctx.athleteId, t, fromDay, ctx.checkCancelled);
      refreshTypeStats(ctx.db, ctx.athleteId, t.id);
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
