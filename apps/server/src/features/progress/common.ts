import { SPORTS, type ProgressDayRange, type ProgressTotals, type ProgressVolumeMetric } from '@cadence/shared';
import { z } from 'zod';
import { all, get, type Db } from '../../db/db';
import { getEffectiveHr, getSetting, getSettings } from '../../core/settings';
import { dayString, parseDay, today as serverToday } from '../../lib/time';

// ---------------------------------------------------------------------------
// Query parameter schemas
// ---------------------------------------------------------------------------

export const zDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((d) => parseDay(d) !== null && dayString(parseDay(d)!) === d, 'invalid date');

/** `sport` query param: a sport key, or empty / 'all' for every sport (→ null). */
export const zSport = z
  .string()
  .max(40)
  .optional()
  .transform((s) => (s && s !== 'all' ? s : null))
  .refine((s) => s === null || Object.hasOwn(SPORTS, s), 'unknown sport');

export const zVolumeMetric = z.enum(['distance', 'time', 'elevation', 'count', 'effort']);

/** Local "today": the browser's day when given (server deployments may run in UTC), else the server's. */
export function resolveToday(day: string | undefined): string {
  return day ?? serverToday();
}

export function weekStartOf(db: Db, athleteId: number): 0 | 1 {
  return getSettings(db, athleteId).weekStart === 0 ? 0 : 1;
}

/**
 * True while an import or rederive job of the athlete is queued or running. Its derive steps fill the per-workout
 * caches of the workouts it adds or changes, so requests leave them alone meanwhile.
 */
export function derivePending(db: Db, athleteId: number): boolean {
  return !!get(
    db,
    "SELECT 1 FROM import_jobs WHERE athlete_id = ? AND status IN ('queued', 'running') LIMIT 1",
    [athleteId],
  );
}

/** workouts.updated_at of the given workouts (deleted ones are missing). */
export function updatedAtOf(db: Db, ids: number[]): Map<number, number> {
  if (!ids.length) return new Map();
  return new Map(
    all<{ id: number; updated_at: number }>(
      db,
      `SELECT id, updated_at FROM workouts WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids,
    ).map((r) => [r.id, r.updated_at]),
  );
}

/** HR zone upper bounds the stored zone times were computed with (falls back to the current effective HR). */
export function zoneBoundsOf(db: Db, athleteId: number): number[] {
  const basis = getSetting<{ zoneBounds?: number[] } | null>(db, athleteId, 'core.effortBasis', null);
  if (basis?.zoneBounds?.length === 4) return basis.zoneBounds;
  return getEffectiveHr(db, athleteId).zoneBounds;
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export function emptyTotals(): ProgressTotals {
  return { count: 0, distanceM: 0, movingS: 0, durationS: 0, elevationM: 0, effort: 0, energyKcal: 0 };
}

export interface DailyActivityRow {
  day: string;
  sport: string;
  count: number;
  duration_s: number;
  moving_s: number;
  distance_m: number;
  elevation_m: number;
  energy_kcal: number;
  effort: number;
}

export function addRow(t: ProgressTotals, r: DailyActivityRow): void {
  t.count += r.count;
  t.distanceM += r.distance_m;
  t.movingS += r.moving_s;
  t.durationS += r.duration_s;
  t.elevationM += r.elevation_m;
  t.effort += r.effort;
  t.energyKcal += r.energy_kcal;
}

/** Totals rounded for transport (m and s to 0.1, effort/kcal to 0.1). */
export function roundTotals(t: ProgressTotals): ProgressTotals {
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    count: t.count,
    distanceM: r1(t.distanceM),
    movingS: r1(t.movingS),
    durationS: r1(t.durationS),
    elevationM: r1(t.elevationM),
    effort: r1(t.effort),
    energyKcal: r1(t.energyKcal),
  };
}

export function metricValue(t: ProgressTotals, metric: ProgressVolumeMetric): number {
  switch (metric) {
    case 'distance':
      return t.distanceM;
    case 'time':
      return t.movingS;
    case 'elevation':
      return t.elevationM;
    case 'count':
      return t.count;
    case 'effort':
      return t.effort;
  }
}

/** daily_activity rows (hidden and duplicate workouts are already excluded by the core). */
export function dailyActivity(
  db: Db,
  athleteId: number,
  sport: string | null,
  fromDay: string,
  toDay: string,
): DailyActivityRow[] {
  return all<DailyActivityRow>(
    db,
    `SELECT day, sport, count, duration_s, moving_s, distance_m, elevation_m, energy_kcal, effort
     FROM daily_activity WHERE athlete_id = ? AND day >= ? AND day <= ? ${sport ? 'AND sport = ?' : ''}
     ORDER BY day`,
    sport ? [athleteId, fromDay, toDay, sport] : [athleteId, fromDay, toDay],
  );
}

export function sumRows(rows: DailyActivityRow[]): ProgressTotals {
  const t = emptyTotals();
  for (const r of rows) addRow(t, r);
  return t;
}

/** First local day with activity (optionally of one sport). */
export function firstActivityDay(db: Db, athleteId: number, sport: string | null): string | null {
  return (
    get<{ d: string | null }>(
      db,
      `SELECT MIN(day) AS d FROM daily_activity WHERE athlete_id = ? ${sport ? 'AND sport = ?' : ''}`,
      sport ? [athleteId, sport] : [athleteId],
    )?.d ?? null
  );
}

// ---------------------------------------------------------------------------
// Workouts by local day
// ---------------------------------------------------------------------------

/**
 * SQL condition + params for visible workouts whose LOCAL start day lies in [fromDay, toDay]. The ts bounds
 * (±1 day for any UTC offset) keep the start-time index usable; the date() term is exact.
 */
export function visibleWorkoutsInDays(
  alias: string,
  athleteId: number,
  sport: string | null,
  fromDay: string,
  toDay: string,
): { where: string; params: unknown[] } {
  const a = parseDay(fromDay)! * 86400 - 86400;
  const b = (parseDay(toDay)! + 2) * 86400;
  const p = alias ? `${alias}.` : '';
  const where = [
    `${p}athlete_id = ?`,
    `${p}hidden = 0`,
    `${p}duplicate_of IS NULL`,
    `${p}start_ts >= ?`,
    `${p}start_ts < ?`,
    `date(${p}start_ts + ${p}tz_min * 60, 'unixepoch') BETWEEN ? AND ?`,
  ];
  const params: unknown[] = [athleteId, a, b, fromDay, toDay];
  if (sport) {
    where.push(`${p}sport = ?`);
    params.push(sport);
  }
  return { where: where.join(' AND '), params };
}

/** The part of a bucket inside the requested range (the first and the last bucket can be partial). */
export function clipRange(b: ProgressDayRange, q: ProgressDayRange): ProgressDayRange {
  return { fromDay: b.fromDay < q.fromDay ? q.fromDay : b.fromDay, toDay: b.toDay > q.toDay ? q.toDay : b.toDay };
}

/** Unix seconds of UTC midnight of a day (used as a stable x value for day-based series). */
export function dayTs(day: string): number {
  return parseDay(day)! * 86400;
}
