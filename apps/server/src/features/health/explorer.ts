import { EXPLORER_SPARK_DAYS, type ExplorerItem, type ExplorerResponse, type ExplorerType } from '@cadence/shared';
import { all, get, type Db } from '../../db/db';
import { addDays, parseDay } from '../../lib/time';
import { combineCategoryRows, type DailyRow } from './series';
import { dataRange } from './util';

interface TypeRow {
  id: number;
  identifier: string;
  kind: ExplorerType['kind'];
  unit: string | null;
  aggregation: ExplorerType['aggregation'];
  count: number;
  first_ts: number | null;
  last_ts: number | null;
}


const dayTs = (day: string | null): number | null => {
  const n = day ? parseDay(day) : null;
  return n === null ? null : n * 86400;
};

/** Every record type with count, time range and a 90-day sparkline, plus counts of all other imported items. */
export function buildExplorer(db: Db, athleteId: number): ExplorerResponse {
  const { asOf } = dataRange(db, athleteId);
  const rows = all<TypeRow>(
    db,
    `SELECT t.id, t.identifier, t.kind, t.unit, t.aggregation, s.count, s.first_ts, s.last_ts
     FROM record_type_stats s JOIN record_types t ON t.id = s.type_id
     WHERE s.athlete_id = ? ORDER BY t.identifier`,
    [athleteId],
  );

  /** value per day of quantity types; daily rows per value of category types ('<identifier>:<value>' metrics) */
  const quantities = new Map<string, Map<string, number>>();
  const categories = new Map<string, Map<string, DailyRow[]>>();
  const days: string[] = [];
  if (asOf) {
    const lo = addDays(asOf, -(EXPLORER_SPARK_DAYS - 1));
    for (let i = 0; i < EXPLORER_SPARK_DAYS; i++) days.push(addDays(lo, i));
    const daily = all<{ metric: string; day: string; value: number; n: number }>(
      db,
      'SELECT metric, day, value, n FROM daily_metrics WHERE athlete_id = ? AND day >= ? AND day <= ?',
      [athleteId, lo, asOf],
    );
    for (const r of daily) {
      const i = r.metric.indexOf(':');
      if (i < 0) {
        let q = quantities.get(r.metric);
        if (!q) quantities.set(r.metric, (q = new Map()));
        q.set(r.day, r.value);
        continue;
      }
      const id = r.metric.slice(0, i);
      const value = r.metric.slice(i + 1);
      let byValue = categories.get(id);
      if (!byValue) categories.set(id, (byValue = new Map()));
      let list = byValue.get(value);
      if (!list) byValue.set(value, (list = []));
      list.push({ day: r.day, value: r.value, min: null, max: null, n: r.n });
    }
  }

  const types: ExplorerType[] = rows.map((r) => {
    let spark: (number | null)[] = days.map(() => null);
    const q = quantities.get(r.identifier);
    const byValue = categories.get(r.identifier);
    if (q) spark = days.map((d) => q.get(d) ?? null);
    else if (byValue) {
      // the same daily totals as the metric page (combineCategoryRows); events without a duration count occurrences
      const combined = new Map(combineCategoryRows(byValue, r.identifier).map((c) => [c.day, c]));
      const minutes = [...combined.values()].some((c) => c.value > 0);
      spark = days.map((d) => {
        const c = combined.get(d);
        return c ? (minutes ? c.value : c.n) : null;
      });
    }
    return {
      id: r.id,
      identifier: r.identifier,
      kind: r.kind,
      unit: r.unit,
      aggregation: r.aggregation,
      count: r.count,
      firstTs: r.first_ts,
      lastTs: r.last_ts,
      spark,
    };
  });

  const items: ExplorerItem[] = [];
  const push = (key: string, count: number | null | undefined, firstTs: number | null, lastTs: number | null) => {
    if (count && count > 0) items.push({ key, count, firstTs, lastTs });
  };
  const summaries = get<{ n: number; lo: string | null; hi: string | null }>(
    db,
    'SELECT COUNT(*) AS n, MIN(day) AS lo, MAX(day) AS hi FROM activity_summaries WHERE athlete_id = ?',
    [athleteId],
  );
  push('activitySummaries', summaries?.n, dayTs(summaries?.lo ?? null), dayTs(summaries?.hi ?? null));
  const workouts = get<{ n: number; lo: number | null; hi: number | null }>(
    db,
    'SELECT COUNT(*) AS n, MIN(start_ts) AS lo, MAX(start_ts) AS hi FROM workouts WHERE athlete_id = ? AND hidden = 0 AND duplicate_of IS NULL',
    [athleteId],
  );
  push('workouts', workouts?.n, workouts?.lo ?? null, workouts?.hi ?? null);
  // visible workouts with a GPS track (has_route is kept by the derive step; the route blobs are not read)
  const routes = get<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM workouts WHERE athlete_id = ? AND hidden = 0 AND duplicate_of IS NULL AND has_route = 1',
    [athleteId],
  );
  push('routes', routes?.n, workouts?.lo ?? null, workouts?.hi ?? null);
  const ecg = get<{ n: number; lo: number | null; hi: number | null }>(
    db,
    'SELECT COUNT(*) AS n, MIN(recorded_ts) AS lo, MAX(recorded_ts) AS hi FROM ecg_readings WHERE athlete_id = ?',
    [athleteId],
  );
  push('ecg', ecg?.n, ecg?.lo ?? null, ecg?.hi ?? null);
  const corr = get<{ n: number; lo: number | null; hi: number | null }>(
    db,
    'SELECT COUNT(*) AS n, MIN(start_ts) AS lo, MAX(start_ts) AS hi FROM correlations WHERE athlete_id = ?',
    [athleteId],
  );
  push('correlations', corr?.n, corr?.lo ?? null, corr?.hi ?? null);
  const KEYS: Record<string, string> = {
    Audiogram: 'audiogram',
    ClinicalRecord: 'clinicalRecord',
    VisionPrescription: 'visionPrescription',
  };
  const other = all<{ kind: string; n: number; lo: number | null; hi: number | null }>(
    db,
    `SELECT kind, COUNT(*) AS n, MIN(start_ts) AS lo, MAX(start_ts) AS hi FROM health_items
     WHERE athlete_id = ? AND kind != 'Me' GROUP BY kind ORDER BY kind`,
    [athleteId],
  );
  for (const o of other) push(KEYS[o.kind] ?? `other:${o.kind}`, o.n, o.lo, o.hi);

  return { asOf, types, items };
}
