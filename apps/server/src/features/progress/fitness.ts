import { heartMetric } from '../../core/sources';
import type {
  ProgressDailySeries,
  ProgressDayValue,
  ProgressFitnessDay,
  ProgressFitnessResponse,
  ProgressPhysiology,
} from '@cadence/shared';
import { all, get, type Db } from '../../db/db';
import { ageFrom, getSettings } from '../../core/settings';
import { addDays, dayString, parseDay } from '../../lib/time';
import { weekStartOf } from './common';
import {
  ACWR_DANGER,
  ACWR_HIGH,
  ACWR_LOW,
  ATL_DAYS,
  acwrStatus,
  bucketsBetween,
  CTL_DAYS,
  FORM_ZONE_BOUNDS,
  formZone,
  mustParseDay,
  RAMP_ELEVATED,
  RAMP_HIGH,
  rampStatus,
  rollingMeanBySpan,
  rollingMedianBySpan,
  trainingLoad,
  vo2Level,
  vo2Levels,
} from './math';

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Fitness (CTL), fatigue (ATL) and form (TSB) from the daily relative effort. The model runs from the first
 * active day up to today (missing days = 0 load), then the requested range is cut out.
 * After the last active day every load is 0: CTL and ATL only decay and the 7 / 28-day load means are 0 after
 * 28 days, so the day by day model stops 35 days after it and later days are extrapolated exactly (a far `today`
 * or `toDay` costs nothing).
 */
export function fitness(
  db: Db,
  athleteId: number,
  q: { sport: string | null; fromDay: string; toDay: string; today: string },
): ProgressFitnessResponse {
  const base = {
    zones: FORM_ZONE_BOUNDS,
    thresholds: {
      rampElevated: RAMP_ELEVATED,
      rampHigh: RAMP_HIGH,
      acwrLow: ACWR_LOW,
      acwrHigh: ACWR_HIGH,
      acwrDanger: ACWR_DANGER,
    },
    constants: { ctlDays: CTL_DAYS, atlDays: ATL_DAYS },
  };
  const rows = all<{ day: string; load: number; n: number }>(
    db,
    `SELECT day, SUM(effort) AS load, SUM(count) AS n FROM daily_activity
     WHERE athlete_id = ? ${q.sport ? 'AND sport = ?' : ''} GROUP BY day ORDER BY day`,
    q.sport ? [athleteId, q.sport] : [athleteId],
  );
  if (!rows.length) return { ...base, days: [], current: null, weeks: [] };
  const start = mustParseDay(rows[0]!.day);
  const last = mustParseDay(rows.at(-1)!.day);
  const end = Math.max(mustParseDay(q.today), last, mustParseDay(q.toDay));
  const dense = Math.min(end, last + 35) - start + 1;
  const loads = new Array<number>(dense).fill(0);
  const counts = new Array<number>(dense).fill(0);
  for (const r of rows) {
    const i = mustParseDay(r.day) - start;
    loads[i] = r.load;
    counts[i] = r.n;
  }
  const model = trainingLoad(loads);
  const D = dense - 1;
  const ctlAt = (i: number) => (i <= D ? model[i]!.ctl : model[D]!.ctl * (1 - 1 / CTL_DAYS) ** (i - D));
  const dayAt = (i: number): ProgressFitnessDay => {
    if (i > D) {
      const ctl = ctlAt(i);
      const atl = model[D]!.atl * (1 - 1 / ATL_DAYS) ** (i - D);
      return { day: dayString(start + i), load: 0, ctl: r1(ctl), atl: r1(atl), tsb: r1(ctl - atl), ramp: r1(ctl - ctlAt(i - 7)), acwr: null };
    }
    return {
      day: dayString(start + i),
      load: r1(loads[i]!),
      ctl: r1(model[i]!.ctl),
      atl: r1(model[i]!.atl),
      tsb: r1(model[i]!.tsb),
      ramp: r1(model[i]!.ramp),
      acwr: model[i]!.acwr === null ? null : Math.round(model[i]!.acwr! * 100) / 100,
    };
  };
  const a = Math.max(0, mustParseDay(q.fromDay) - start);
  const b = mustParseDay(q.toDay) - start;
  const days: ProgressFitnessDay[] = [];
  for (let i = a; i <= b; i++) days.push(dayAt(i));

  const ti = mustParseDay(q.today) - start;
  let current: ProgressFitnessResponse['current'] = null;
  if (ti >= 0) {
    const d = dayAt(ti);
    current = { ...d, zone: formZone(d.tsb), rampStatus: rampStatus(d.ramp), acwrStatus: acwrStatus(d.acwr) };
  }

  const weekStart = weekStartOf(db, athleteId);
  // only the days of the range (the first and the last week can be partial, like the volume buckets)
  const fromN = mustParseDay(q.fromDay);
  const toN = mustParseDay(q.toDay);
  const weeks = bucketsBetween(q.fromDay, q.toDay, 'week', weekStart).map((w) => {
    const ws = mustParseDay(w.fromDay);
    const wa = Math.max(ws, fromN);
    const wb = Math.min(ws + 6, toN);
    let load = 0;
    let count = 0;
    for (let d = wa; d <= wb; d++) {
      const i = d - start;
      if (i < 0 || i >= loads.length) continue;
      load += loads[i]!;
      count += counts[i]!;
    }
    return { ...w, fromDay: dayString(wa), toDay: dayString(wb), load: r1(load), count };
  });
  return { ...base, days, current, weeks };
}

// ---------------------------------------------------------------------------
// Physiology context: VO2max (+ fitness level), resting heart rate, HRV
// ---------------------------------------------------------------------------


function metricSeries(db: Db, athleteId: number, metric: string, fromDay: string, toDay: string, lo: number, hi: number) {
  return all<ProgressDayValue>(
    db,
    `SELECT day, value FROM daily_metrics WHERE athlete_id = ? AND metric = ? AND day >= ? AND day <= ?
       AND value BETWEEN ? AND ? ORDER BY day`,
    [athleteId, metric, fromDay, toDay, lo, hi],
  );
}

/** Points in [fromDay, toDay] with a trailing statistic over `spanDays` (computed with earlier points too). */
function trailing(
  db: Db,
  athleteId: number,
  metric: string,
  fromDay: string,
  toDay: string,
  spanDays: number,
  lo: number,
  hi: number,
  stat: 'mean' | 'median',
): { points: ProgressDayValue[]; trail: number[] } {
  const rows = metricSeries(db, athleteId, metric, addDays(fromDay, -spanDays), toDay, lo, hi);
  const xs = rows.map((r) => parseDay(r.day)!);
  const vs = rows.map((r) => r.value);
  const trail = stat === 'mean' ? rollingMeanBySpan(xs, vs, spanDays) : rollingMedianBySpan(xs, vs, spanDays);
  const first = rows.findIndex((r) => r.day >= fromDay);
  const k = first < 0 ? rows.length : first;
  return {
    points: rows.slice(k).map((r) => ({ day: r.day, value: Math.round(r.value * 100) / 100 })),
    trail: trail.slice(k).map((v) => Math.round(v * 100) / 100),
  };
}

function latestOf(db: Db, athleteId: number, metric: string, toDay: string, lo: number, hi: number): ProgressDayValue | null {
  const r = get<ProgressDayValue>(
    db,
    `SELECT day, value FROM daily_metrics WHERE athlete_id = ? AND metric = ? AND day <= ? AND value BETWEEN ? AND ?
     ORDER BY day DESC LIMIT 1`,
    [athleteId, metric, toDay, lo, hi],
  );
  return r ? { day: r.day, value: Math.round(r.value * 100) / 100 } : null;
}

function dailySeries(db: Db, athleteId: number, metric: string, fromDay: string, toDay: string, lo: number, hi: number): ProgressDailySeries {
  const { points, trail } = trailing(db, athleteId, metric, fromDay, toDay, 7, lo, hi, 'mean');
  return { points, avg7: trail, latest: latestOf(db, athleteId, metric, toDay, lo, hi) };
}

export function physiology(db: Db, athleteId: number, q: { fromDay: string; toDay: string }): ProgressPhysiology {
  const settings = getSettings(db, athleteId);
  const athlete = get<{ birth_date: string | null; sex: string | null }>(
    db,
    'SELECT birth_date, sex FROM athletes WHERE id = ?',
    [athleteId],
  );
  const birthDate = settings.birthDate ?? athlete?.birth_date ?? null;
  const sexRaw = settings.sex ?? athlete?.sex ?? null;
  const sex = sexRaw === 'male' || sexRaw === 'female' || sexRaw === 'other' ? sexRaw : null;
  const VO2 = heartMetric(db, athleteId, 'vo2max', settings);
  const vo2 = trailing(db, athleteId, VO2, q.fromDay, q.toDay, 30, 10, 95, 'median');
  const latest = latestOf(db, athleteId, VO2, q.toDay, 10, 95);
  const at = latest ? new Date(`${latest.day}T12:00:00Z`) : new Date();
  const age = ageFrom(birthDate, at);
  const levels = vo2Levels(age, sex);
  return {
    vo2max: {
      points: vo2.points,
      median: vo2.trail,
      latest,
      level: levels && latest ? vo2Level(latest.value, levels) : null,
      levels,
      age,
      sex,
    },
    restingHr: dailySeries(db, athleteId, heartMetric(db, athleteId, 'restingHr'), q.fromDay, q.toDay, 25, 140),
    hrv: dailySeries(db, athleteId, heartMetric(db, athleteId, 'hrv'), q.fromDay, q.toDay, 3, 300),
  };
}
