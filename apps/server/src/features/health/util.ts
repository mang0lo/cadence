import { z } from 'zod';
import { DEFAULT_HEALTH_SETTINGS, type HealthSettings, type RecordTypeInfo } from '@cadence/shared';
import { get, type Db } from '../../db/db';
import { firstRecord, lastRecord } from '../../core/coverage';
import { getSetting, setSetting } from '../../core/settings';
import { badRequest, HttpError, notFound } from '../../lib/http';
import { parseDay } from '../../lib/time';

/** A local day 'YYYY-MM-DD' that exists in the calendar (2026-02-30 is a 400, not an empty or failing answer). */
export const dayParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((d) => parseDay(d) !== null, 'not a calendar day');

/** Margin around a range of local days in UTC: offsets reach −12 / +14 h (a little more for safety). */
const TZ_WINDOW_S = 15 * 3600;

/**
 * Local days [fromDay, toDay] as timestamps: [lo, hi) is a UTC window that surely contains them (for the start_ts
 * indexes), and a sample lies on those days when start_ts + tz_min * 60 ∈ [localLo, localHi). Open ends stay open.
 */
export interface LocalDayRange {
  lo: number;
  hi: number;
  localLo: number | null;
  localHi: number | null;
}

export function localDayRange(fromDay?: string, toDay?: string): LocalDayRange {
  const start = (day: string) => {
    const n = parseDay(day);
    if (n === null) throw badRequest(`Invalid day ${day}`);
    return n * 86_400;
  };
  const localLo = fromDay ? start(fromDay) : null;
  const localHi = toDay ? start(toDay) + 86_400 : null;
  return {
    lo: localLo === null ? -1e12 : localLo - TZ_WINDOW_S,
    hi: localHi === null ? 1e12 : localHi + TZ_WINDOW_S,
    localLo,
    localHi,
  };
}

/**
 * SQL condition of a LocalDayRange on a table with start_ts / tz_min (`alias.`): the UTC window for the index plus
 * the exact local days as integer arithmetic (no date() call per row).
 */
export function localDaySql(alias: string, r: LocalDayRange): { sql: string; params: number[] } {
  const local = `${alias}.start_ts + ${alias}.tz_min * 60`;
  let sql = `${alias}.start_ts >= ? AND ${alias}.start_ts < ?`;
  const params = [r.lo, r.hi];
  if (r.localLo !== null) {
    sql += ` AND ${local} >= ?`;
    params.push(r.localLo);
  }
  if (r.localHi !== null) {
    sql += ` AND ${local} < ?`;
    params.push(r.localHi);
  }
  return { sql, params };
}

export interface TypeRow {
  id: number;
  identifier: string;
  kind: RecordTypeInfo['kind'];
  unit: string | null;
  aggregation: RecordTypeInfo['aggregation'];
}

const PREFIXES = ['', 'HKQuantityTypeIdentifier', 'HKCategoryTypeIdentifier', 'HKDataType'];

/**
 * Looks up a record type by its full identifier; also accepts the short form ('HeartRate') as a convenience.
 * Throws 404 for unknown types.
 */
export function resolveType(db: Db, input: string): TypeRow {
  for (const prefix of PREFIXES) {
    const row = get<TypeRow>(db, 'SELECT id, identifier, kind, unit, aggregation FROM record_types WHERE identifier = ?', [
      prefix + input,
    ]);
    if (row) return row;
  }
  throw notFound('Record type');
}

export function typeIdByIdentifier(db: Db, identifier: string): number | null {
  return get<{ id: number }>(db, 'SELECT id FROM record_types WHERE identifier = ?', [identifier])?.id ?? null;
}

/** Aggregation of a daily_metrics key: category composites ('<id>:<value>') are durations. */
export function aggregationOfMetric(db: Db, metric: string): RecordTypeInfo['aggregation'] | null {
  const identifier = metric.includes(':') ? metric.slice(0, metric.indexOf(':')) : metric;
  const row = get<{ aggregation: RecordTypeInfo['aggregation'] }>(
    db,
    'SELECT aggregation FROM record_types WHERE identifier = ?',
    [identifier],
  );
  return row?.aggregation ?? null;
}

/**
 * Earliest / latest local day with a health record of any source (Apple Health, COROS daily values): the anchor for
 * "last 30 days" style ranges. Same records as the data horizon of the consistency pages (core/coverage.ts).
 */
export function dataRange(db: Db, athleteId: number): { firstDay: string | null; asOf: string | null } {
  return { asOf: lastRecord(db, athleteId)?.day ?? null, firstDay: firstRecord(db, athleteId)?.day ?? null };
}

const SETTINGS_KEY = 'health.settings';

export function getHealthSettings(db: Db, athleteId: number): HealthSettings {
  return { ...DEFAULT_HEALTH_SETTINGS, ...getSetting<Partial<HealthSettings>>(db, athleteId, SETTINGS_KEY, {}) };
}

export function putHealthSettings(db: Db, athleteId: number, patch: Partial<HealthSettings>): HealthSettings {
  const next = { ...getHealthSettings(db, athleteId), ...patch };
  setSetting(db, athleteId, SETTINGS_KEY, next);
  return next;
}

/** Throws 400 when `from` is after `to`. */
export function checkDayOrder(from: string | undefined, to: string | undefined): void {
  if (from && to && from > to) throw new HttpError(400, 'invalid_request', 'fromDay must not be after toDay');
}
