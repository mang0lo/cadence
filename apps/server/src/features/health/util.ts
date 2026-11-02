import { z } from 'zod';
import { DEFAULT_HEALTH_SETTINGS, type HealthSettings, type RecordTypeInfo } from '@cadence/shared';
import { get, type Db } from '../../db/db';
import { getSetting, setSetting } from '../../core/settings';
import { HttpError, notFound } from '../../lib/http';
import { localDay, nowSec } from '../../lib/time';

export const dayParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

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

/** Earliest / latest local day with any health record (anchor for "last 30 days" style ranges). */
export function dataRange(db: Db, athleteId: number): { firstDay: string | null; asOf: string | null } {
  const limit = nowSec() + 86_400;
  const tzAt = (typeId: number, ts: number) =>
    get<{ tz_min: number }>(db, 'SELECT tz_min FROM records WHERE athlete_id = ? AND type_id = ? AND start_ts = ? LIMIT 1', [
      athleteId,
      typeId,
      ts,
    ])?.tz_min ?? 0;
  const last = get<{ type_id: number; last_ts: number }>(
    db,
    `SELECT type_id, last_ts FROM record_type_stats WHERE athlete_id = ? AND last_ts IS NOT NULL AND last_ts <= ?
     ORDER BY last_ts DESC LIMIT 1`,
    [athleteId, limit],
  );
  const first = get<{ type_id: number; first_ts: number }>(
    db,
    `SELECT type_id, first_ts FROM record_type_stats WHERE athlete_id = ? AND first_ts IS NOT NULL AND first_ts >= 946684800
     ORDER BY first_ts ASC LIMIT 1`,
    [athleteId],
  );
  return {
    asOf: last ? localDay(last.last_ts, tzAt(last.type_id, last.last_ts)) : null,
    firstDay: first ? localDay(first.first_ts, tzAt(first.type_id, first.first_ts)) : null,
  };
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
