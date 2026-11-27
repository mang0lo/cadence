import {
  PROGRESS_POWER_DURATIONS,
  type ProgressBodyMass,
  type ProgressCriticalPower,
  type ProgressFtpHistoryPoint,
  type ProgressFtpResponse,
  type ProgressPowerCompare,
  type ProgressPowerCurve,
  type ProgressPowerCurveResponse,
  type ProgressPowerEffort,
  type ProgressPowerPeriod,
} from '@cadence/shared';
import { all, get, type Db } from '../../db/db';
import { addDays } from '../../lib/time';
import { bucketsBetween } from './math';
import { ensurePowerBests } from './power-curve';
import {
  criticalPowerFit,
  FTP_DURATION_S,
  FTP_FACTOR,
  FTP_WINDOWS,
  powerPeriodRange,
  previousPowerRange,
  type DayRange,
} from './power-math';

const BODY_MASS = 'HKQuantityTypeIdentifierBodyMass';
/** Every workout with power has a best for the shortest duration: its row marks "workout with power data". */
const FIRST_DURATION = PROGRESS_POWER_DURATIONS[0]!;
const VISIBLE = 'w.hidden = 0 AND w.duplicate_of IS NULL';
/** More months than this → quarterly FTP history. */
const MAX_MONTHS = 36;

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Latest plausible body mass (kg) on or before `day` (daily_metrics hold the daily mean). */
export function bodyMassAt(db: Db, athleteId: number, day: string): ProgressBodyMass | null {
  const r = get<{ day: string; value: number }>(
    db,
    `SELECT day, value FROM daily_metrics WHERE athlete_id = ? AND metric = ? AND day <= ? AND value BETWEEN 25 AND 300
     ORDER BY day DESC LIMIT 1`,
    [athleteId, BODY_MASS, day],
  );
  return r ? { kg: r1(r.value), day: r.day } : null;
}

interface BestRow {
  duration_s: number;
  watts: number;
  offset_s: number;
  workout_id: number;
  name: string;
  sport: string;
  start_ts: number;
  tz_min: number;
}

const BEST_COLS = 'b.duration_s, b.watts, b.offset_s, b.workout_id, w.name, b.sport, w.start_ts, w.tz_min';

/**
 * The best effort per duration among the visible workouts of a sport with a local start day in [fromDay, toDay].
 * Ties go to the earlier effort.
 */
function bestRows(db: Db, athleteId: number, sport: string, r: DayRange, durationS?: number): BestRow[] {
  const one = durationS !== undefined;
  return all<BestRow>(
    db,
    `SELECT duration_s, watts, offset_s, workout_id, name, sport, start_ts, tz_min FROM (
       SELECT ${BEST_COLS}, ROW_NUMBER() OVER (PARTITION BY b.duration_s ORDER BY b.watts DESC, w.start_ts, w.id) AS rn
       FROM progress_power_bests b JOIN workouts w ON w.id = b.workout_id
       WHERE b.athlete_id = ? AND b.sport = ? AND b.day >= ? AND b.day <= ? ${one ? 'AND b.duration_s = ?' : ''}
         AND ${VISIBLE}
     ) WHERE rn = 1 ORDER BY duration_s`,
    one ? [athleteId, sport, r.fromDay, r.toDay, durationS] : [athleteId, sport, r.fromDay, r.toDay],
  );
}

function toEffort(r: BestRow, kg: number | null): ProgressPowerEffort {
  const watts = r1(r.watts);
  return {
    durationS: r.duration_s,
    watts,
    wkg: kg ? r2(watts / kg) : null,
    workoutId: r.workout_id,
    name: r.name,
    sport: r.sport,
    startTs: r.start_ts,
    tzMin: r.tz_min,
    offsetS: Math.round(r.offset_s),
  };
}

/** Sports with power data (visible workouts), most workouts first. */
export function powerSports(db: Db, athleteId: number): { sport: string; workouts: number }[] {
  return all<{ sport: string; workouts: number }>(
    db,
    `SELECT b.sport, COUNT(*) AS workouts FROM progress_power_bests b JOIN workouts w ON w.id = b.workout_id
     WHERE b.athlete_id = ? AND b.duration_s = ? AND ${VISIBLE}
     GROUP BY b.sport ORDER BY workouts DESC, b.sport`,
    [athleteId, FIRST_DURATION],
  );
}

/** Rides when they have power data, else the sport with the most power workouts (ride without any data). */
export function defaultPowerSport(sports: { sport: string }[]): string {
  return sports.some((s) => s.sport === 'ride') ? 'ride' : (sports[0]?.sport ?? 'ride');
}

interface PowerSpan {
  firstDay: string | null;
  lastDay: string | null;
  /** Calendar years with power data, newest first. */
  years: number[];
}

function powerSpan(db: Db, athleteId: number, sport: string): PowerSpan {
  const years = all<{ y: string; first: string; last: string }>(
    db,
    `SELECT substr(b.day, 1, 4) AS y, MIN(b.day) AS first, MAX(b.day) AS last
     FROM progress_power_bests b JOIN workouts w ON w.id = b.workout_id
     WHERE b.athlete_id = ? AND b.sport = ? AND b.duration_s = ? AND ${VISIBLE}
     GROUP BY y ORDER BY y DESC`,
    [athleteId, sport, FIRST_DURATION],
  );
  return {
    firstDay: years.at(-1)?.first ?? null,
    lastDay: years[0]?.last ?? null,
    years: years.map((r) => Number(r.y)),
  };
}

function curveOf(db: Db, athleteId: number, sport: string, r: DayRange): ProgressPowerCurve {
  const bodyMass = bodyMassAt(db, athleteId, r.toDay);
  const kg = bodyMass?.kg ?? null;
  const workouts =
    get<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM progress_power_bests b JOIN workouts w ON w.id = b.workout_id
       WHERE b.athlete_id = ? AND b.sport = ? AND b.duration_s = ? AND b.day >= ? AND b.day <= ? AND ${VISIBLE}`,
      [athleteId, sport, FIRST_DURATION, r.fromDay, r.toDay],
    )?.n ?? 0;
  return {
    fromDay: r.fromDay,
    toDay: r.toDay,
    points: bestRows(db, athleteId, sport, r).map((row) => toEffort(row, kg)),
    workouts,
    bodyMass,
  };
}

/** Power curve of a period plus a comparison curve (all-time bests or the period before). */
export function powerCurve(
  db: Db,
  athleteId: number,
  q: {
    sport: string | null;
    period: ProgressPowerPeriod;
    year?: number;
    fromDay?: string;
    toDay?: string;
    compare: ProgressPowerCompare;
    today: string;
  },
): ProgressPowerCurveResponse {
  ensurePowerBests(db, athleteId);
  const sports = powerSports(db, athleteId);
  const sport = q.sport ?? defaultPowerSport(sports);
  const span = powerSpan(db, athleteId, sport);
  const range = powerPeriodRange(q.period, q.today, {
    year: q.year,
    fromDay: q.fromDay,
    toDay: q.toDay,
    span,
  });
  // all time compared with all time (or with nothing before it) says nothing
  const compare: ProgressPowerCompare = q.period === 'all' ? 'none' : q.compare;
  const cmpRange =
    compare === 'previous'
      ? previousPowerRange(q.period, range)
      : compare === 'allTime'
        ? powerPeriodRange('all', q.today, { span })
        : null;
  return {
    sport,
    sports,
    years: span.years,
    period: q.period,
    compare,
    current: curveOf(db, athleteId, sport, range),
    comparison: cmpRange ? curveOf(db, athleteId, sport, cmpRange) : null,
  };
}

/**
 * FTP estimate (95 % of the best 20 minutes of the last 6 weeks, else of the last 90 days), the critical power
 * model and the bests of the same window, and (unless `history` is false: the dashboard) the estimate per month
 * (quarter) since the first power data.
 */
export function ftpEstimate(
  db: Db,
  athleteId: number,
  q: { sport: string | null; today: string; history?: boolean },
): ProgressFtpResponse {
  ensurePowerBests(db, athleteId);
  const sports = powerSports(db, athleteId);
  const sport = q.sport ?? defaultPowerSport(sports);
  const bodyMass = bodyMassAt(db, athleteId, q.today);
  const kg = bodyMass?.kg ?? null;
  let windowDays: number | null = null;
  let windowRows: BestRow[] = [];
  let source: ProgressPowerEffort | null = null;
  let criticalPower: ProgressCriticalPower | null = null;
  let criticalPowerIssue: ProgressFtpResponse['criticalPowerIssue'] = 'tooFew';
  for (const days of FTP_WINDOWS) {
    const rows = bestRows(db, athleteId, sport, { fromDay: addDays(q.today, -(days - 1)), toDay: q.today });
    // without an estimate the bests are those of the first (shortest) window
    if (days === FTP_WINDOWS[0]) windowRows = rows;
    const best = rows.find((r) => r.duration_s === FTP_DURATION_S);
    if (!best) continue;
    windowDays = days;
    windowRows = rows;
    source = toEffort(best, kg);
    const cp = criticalPowerFit(rows.map((r) => ({ durationS: r.duration_s, watts: r.watts })));
    criticalPowerIssue = cp.issue;
    if (cp.fit) {
      criticalPower = {
        cpW: r1(cp.fit.cpW),
        wPrimeJ: Math.round(cp.fit.wPrimeJ),
        r2: Math.round(cp.fit.r2 * 10_000) / 10_000,
        maxError: Math.round(cp.fit.maxError * 1000) / 1000,
        durations: cp.fit.durations,
        cpWkg: kg ? r2(cp.fit.cpW / kg) : null,
      };
    }
    break;
  }
  const ftp = source ? r1(FTP_FACTOR * source.watts) : null;
  return {
    sport,
    sports,
    today: q.today,
    factor: FTP_FACTOR,
    windowDays,
    ftp,
    ftpWkg: ftp !== null && kg ? r2(ftp / kg) : null,
    source,
    criticalPower,
    criticalPowerIssue: criticalPower ? null : criticalPowerIssue,
    bodyMass,
    windowBests: windowRows.map((r) => toEffort(r, kg)),
    history: q.history === false ? { bucket: 'month', points: [] } : ftpHistory(db, athleteId, sport, q.today),
  };
}

/** FTP estimate per month (per quarter beyond MAX_MONTHS months): 95 % of the bucket's best 20 minutes. */
function ftpHistory(db: Db, athleteId: number, sport: string, today: string): ProgressFtpResponse['history'] {
  const span = powerSpan(db, athleteId, sport);
  if (!span.firstDay) return { bucket: 'month', points: [] };
  const end = span.lastDay && span.lastDay > today ? span.lastDay : today;
  const months = bucketsBetween(span.firstDay, end, 'month', 1);
  const rows = all<BestRow & { month: string }>(
    db,
    `SELECT month, duration_s, watts, offset_s, workout_id, name, sport, start_ts, tz_min FROM (
       SELECT substr(b.day, 1, 7) AS month, ${BEST_COLS},
         ROW_NUMBER() OVER (PARTITION BY substr(b.day, 1, 7) ORDER BY b.watts DESC, w.start_ts, w.id) AS rn
       FROM progress_power_bests b JOIN workouts w ON w.id = b.workout_id
       WHERE b.athlete_id = ? AND b.sport = ? AND b.duration_s = ? AND ${VISIBLE}
     ) WHERE rn = 1`,
    [athleteId, sport, FTP_DURATION_S],
  );
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const quarterly = months.length > MAX_MONTHS;
  const buckets: { key: string; fromDay: string; toDay: string; best: BestRow | null }[] = [];
  for (const m of months) {
    const row = byMonth.get(m.key) ?? null;
    const key = quarterly
      ? `${m.key.slice(0, 4)}-Q${Math.floor((Number(m.key.slice(5, 7)) - 1) / 3) + 1}`
      : m.key;
    const last = buckets.at(-1);
    if (last && last.key === key) {
      last.toDay = m.toDay;
      // months come in order: on a tie the earlier effort keeps the bucket
      if (row && (!last.best || row.watts > last.best.watts)) last.best = row;
    } else buckets.push({ key, fromDay: m.fromDay, toDay: m.toDay, best: row });
  }
  const points = buckets.map((b): ProgressFtpHistoryPoint => {
    if (!b.best)
      return { key: b.key, fromDay: b.fromDay, toDay: b.toDay, ftp: null, ftpWkg: null, source: null };
    const kg = bodyMassAt(db, athleteId, b.toDay)?.kg ?? null;
    const source = toEffort(b.best, kg);
    const ftp = r1(FTP_FACTOR * source.watts);
    return { key: b.key, fromDay: b.fromDay, toDay: b.toDay, ftp, ftpWkg: kg ? r2(ftp / kg) : null, source };
  });
  return { bucket: quarterly ? 'quarter' : 'month', points };
}
