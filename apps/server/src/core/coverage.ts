/**
 * Data coverage: how far the athlete's data reaches, per source and overall. One place for "as of" so every page
 * judges the same days — consistency (streaks, goals) uses `dataHorizon` / `resolveDays`, health anchors its pages on
 * `lastRecord` and ends its cumulative cards at `lastCompleteDay` of the metric's source.
 *
 * Sources: Apple Health records and the time of the newest export, the records of device clouds (COROS daily values:
 * resting HR, load, steps …, written for every day the watch was worn, rest days included), workouts of every source
 * (daily_activity: Apple Health, FIT files, COROS) and the activity rings (Apple, COROS app).
 */
import { all, get, type Db } from '../db/db';
import { parseAppleDate } from '../import/dates';
import { dayString, epochDay, localDay, nowSec, today as serverToday } from '../lib/time';

/** Records of one origin: 'apple' = HealthKit types (HK…), 'coros' = COROS cloud values (COROS…). */
export type RecordFamily = 'apple' | 'coros';

const FAMILY_PATTERN: Record<RecordFamily, string> = { apple: 'HK%', coros: 'COROS%' };

/** The family a daily_metrics key or record type identifier belongs to. */
export const familyOf = (metric: string): RecordFamily => (metric.startsWith('COROS') ? 'coros' : 'apple');

/** A moment of the data: unix seconds, the UTC offset in effect then, and its local day. */
export interface DataMoment {
  ts: number;
  tzMin: number;
  day: string;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Records dated before 2000 are clock errors of some sources (1970, 2001-01-01 …), not real history. */
const MIN_FIRST_TS = 946_684_800;

const moment = (ts: number, tzMin: number): DataMoment => ({ ts, tzMin, day: localDay(ts, tzMin) });

/** Offset of a record (record_type_stats keeps the times only). */
function tzOf(db: Db, athleteId: number, typeId: number, ts: number): number {
  return (
    get<{ tz_min: number }>(db, 'SELECT tz_min FROM records WHERE athlete_id = ? AND type_id = ? AND start_ts = ? LIMIT 1', [
      athleteId,
      typeId,
      ts,
    ])?.tz_min ?? 0
  );
}

/**
 * Start of the newest record of every source (or of one family), from record_type_stats. Samples more than a day in
 * the future are ignored: a wrong clock of one source must not move "as of" into days nobody has lived yet.
 */
export function lastRecord(db: Db, athleteId: number, family?: RecordFamily, now = nowSec()): DataMoment | null {
  const r = get<{ type_id: number; last_ts: number }>(
    db,
    `SELECT s.type_id, s.last_ts FROM record_type_stats s
     ${family ? 'JOIN record_types t ON t.id = s.type_id AND t.identifier LIKE ?' : ''}
     WHERE s.athlete_id = ? AND s.last_ts IS NOT NULL AND s.last_ts <= ?
     ORDER BY s.last_ts DESC LIMIT 1`,
    [...(family ? [FAMILY_PATTERN[family]] : []), athleteId, now + 86_400],
  );
  return r ? moment(r.last_ts, tzOf(db, athleteId, r.type_id, r.last_ts)) : null;
}

/** Start of the oldest record of every source (or of one family), ignoring clock errors before 2000. */
export function firstRecord(db: Db, athleteId: number, family?: RecordFamily): DataMoment | null {
  const r = get<{ type_id: number; first_ts: number }>(
    db,
    `SELECT s.type_id, s.first_ts FROM record_type_stats s
     ${family ? 'JOIN record_types t ON t.id = s.type_id AND t.identifier LIKE ?' : ''}
     WHERE s.athlete_id = ? AND s.first_ts IS NOT NULL AND s.first_ts >= ?
     ORDER BY s.first_ts ASC LIMIT 1`,
    [...(family ? [FAMILY_PATTERN[family]] : []), athleteId, MIN_FIRST_TS],
  );
  return r ? moment(r.first_ts, tzOf(db, athleteId, r.type_id, r.first_ts)) : null;
}

/**
 * Time of the newest Apple Health export the athlete imported (export.xml's ExportDate, kept in the stats of the
 * import job). Jobs of FIT files and COROS syncs have no export date and are skipped.
 */
export function lastAppleExport(db: Db, athleteId: number): DataMoment | null {
  let best: DataMoment | null = null;
  for (const r of all<{ d: unknown }>(
    db,
    `SELECT CASE WHEN json_valid(stats) THEN json_extract(stats, '$.exportDate') END AS d FROM import_jobs
     WHERE athlete_id = ? AND kind = 'import' AND status = 'done'`,
    [athleteId],
  )) {
    const p = typeof r.d === 'string' ? parseAppleDate(r.d) : null;
    if (p && (!best || p.ts > best.ts)) best = moment(p.ts, p.tzMin);
  }
  return best;
}

/** Where the data of one family ends. Apple: the newest record or the time of the newest export, whichever is later. */
export function sourceEnd(db: Db, athleteId: number, family: RecordFamily, now = nowSec()): DataMoment | null {
  const rec = lastRecord(db, athleteId, family, now);
  if (family !== 'apple') return rec;
  const exp = lastAppleExport(db, athleteId);
  return exp && (!rec || exp.ts > rec.ts) ? exp : rec;
}

/** From this local time on, a day whose data ends then counts as complete (the rest of the evening adds little). */
export const COMPLETE_FROM_MIN = 23 * 60;

/**
 * The last complete local day of data that ends at `end`: that day itself when the data reaches into its last hour,
 * else the day before (an export taken at 08:00 holds only the morning of its day). A moment in the future (wrong
 * clocks) counts as now.
 */
export function lastCompleteDay(end: DataMoment, now = nowSec()): string {
  const ts = Math.min(end.ts, now);
  const day = epochDay(ts, end.tzMin);
  const minute = Math.floor((ts + end.tzMin * 60 - day * 86_400) / 60);
  return dayString(minute >= COMPLETE_FROM_MIN ? day : day - 1);
}

const later = (a: string | null | undefined, b: string | null | undefined): string | null =>
  a && b ? (a > b ? a : b) : (a ?? b ?? null);

/**
 * The last local day the athlete's data covers: the newest record of any source (Apple Health, COROS daily values),
 * workout, ring day, or the day of the newest Apple Health export (an export covers its days even without records).
 */
export function dataHorizon(db: Db, athleteId: number, now = nowSec()): string | null {
  const r = get<{ d: string | null }>(
    db,
    `SELECT MAX(d) AS d FROM (
       SELECT MAX(day) AS d FROM activity_summaries WHERE athlete_id = ?
       UNION ALL SELECT MAX(day) FROM daily_activity WHERE athlete_id = ?
     )`,
    [athleteId, athleteId],
  );
  return later(later(r?.d, lastRecord(db, athleteId, undefined, now)?.day), lastAppleExport(db, athleteId)?.day);
}

/** today = the client's day (or the server's); asOf = today, or the data horizon when the data is older. */
export function resolveDays(db: Db, athleteId: number, today?: string): { today: string; asOf: string } {
  const t = today && DAY_RE.test(today) ? today : serverToday();
  const horizon = dataHorizon(db, athleteId);
  return { today: t, asOf: horizon && horizon < t ? horizon : t };
}
