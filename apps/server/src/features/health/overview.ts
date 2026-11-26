import { familyOf, lastCompleteDay, sourceEnd, type RecordFamily } from '../../core/coverage';
import { getSettings } from '../../core/settings';
import { heartMetric } from '../../core/sources';
import {
  OVERVIEW_METRICS,
  OVERVIEW_SPARK_DAYS,
  type DailyMetric,
  type HealthMeta,
  type HealthMetricCard,
  type HealthOverview,
  type HealthSnapshot,
  type SnapshotValue,
} from '@cadence/shared';
import { all, get, type Db } from '../../db/db';
import { addDays, nowSec } from '../../lib/time';
import { aggregationOfMetric, dataRange, getHealthSettings } from './util';

interface DayRow {
  day: string;
  value: number;
}

/** Daily values of a key metric ('sleep' = asleep minutes per night) between two days (inclusive). */
export function dailyValues(db: Db, athleteId: number, metric: string, from: string, to: string): DayRow[] {
  if (metric === 'sleep') {
    return all<DayRow>(
      db,
      `SELECT day, asleep_s / 60.0 AS value FROM health_sleep_nights
       WHERE athlete_id = ? AND kind = 'night' AND asleep_s > 0 AND day >= ? AND day <= ? ORDER BY day`,
      [athleteId, from, to],
    );
  }
  return all<DayRow>(
    db,
    'SELECT day, value FROM daily_metrics WHERE athlete_id = ? AND metric = ? AND day >= ? AND day <= ? ORDER BY day',
    [athleteId, metric, from, to],
  );
}

function latestValue(db: Db, athleteId: number, metric: string, to: string): DayRow | null {
  if (metric === 'sleep') {
    return (
      get<DayRow>(
        db,
        `SELECT day, asleep_s / 60.0 AS value FROM health_sleep_nights
         WHERE athlete_id = ? AND kind = 'night' AND asleep_s > 0 AND day <= ? ORDER BY day DESC LIMIT 1`,
        [athleteId, to],
      ) ?? null
    );
  }
  return (
    get<DayRow>(
      db,
      'SELECT day, value FROM daily_metrics WHERE athlete_id = ? AND metric = ? AND day <= ? ORDER BY day DESC LIMIT 1',
      [athleteId, metric, to],
    ) ?? null
  );
}

function firstDayOf(db: Db, athleteId: number, metric: string): string | null {
  if (metric === 'sleep') {
    return (
      get<{ d: string | null }>(
        db,
        `SELECT MIN(day) AS d FROM health_sleep_nights WHERE athlete_id = ? AND kind = 'night' AND asleep_s > 0`,
        [athleteId],
      )?.d ?? null
    );
  }
  return (
    get<{ d: string | null }>(db, 'SELECT MIN(day) AS d FROM daily_metrics WHERE athlete_id = ? AND metric = ?', [
      athleteId,
      metric,
    ])?.d ?? null
  );
}

/** Pure part of a card: windows, averages and the sparkline from daily rows (sorted by day). */
export function summarizeWindows(
  rows: DayRow[],
  end: string,
  firstDay: string | null,
  cumulative: boolean,
  sparkDays = OVERVIEW_SPARK_DAYS,
): Pick<HealthMetricCard, 'avg30' | 'n30' | 'avgPrev30' | 'nPrev30' | 'spark'> {
  const byDay = new Map(rows.map((r) => [r.day, r.value]));
  const spark: (number | null)[] = [];
  for (let i = sparkDays - 1; i >= 0; i--) spark.push(byDay.get(addDays(end, -i)) ?? null);

  const windowAvg = (lo: string, hi: string): { avg: number | null; n: number } => {
    let sum = 0;
    let n = 0;
    if (cumulative) {
      // days without a record count as zero, but only from the first day the metric exists
      const start = firstDay && firstDay > lo ? firstDay : lo;
      if (start > hi) return { avg: null, n: 0 };
      let d = start;
      while (d <= hi) {
        sum += byDay.get(d) ?? 0;
        n++;
        d = addDays(d, 1);
      }
    } else {
      let d = lo;
      while (d <= hi) {
        const v = byDay.get(d);
        if (v !== undefined) {
          sum += v;
          n++;
        }
        d = addDays(d, 1);
      }
    }
    return { avg: n ? sum / n : null, n };
  };
  const cur = windowAvg(addDays(end, -29), end);
  const prev = windowAvg(addDays(end, -59), addDays(end, -30));
  return { avg30: cur.avg, n30: cur.n, avgPrev30: prev.avg, nPrev30: prev.n, spark };
}

export function buildMeta(db: Db, athleteId: number): HealthMeta {
  const { asOf, firstDay } = dataRange(db, athleteId);
  return {
    asOf,
    firstDay,
    sleepNights:
      get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM health_sleep_nights WHERE athlete_id = ? AND kind = 'night'`, [athleteId])
        ?.n ?? 0,
    ecgCount: get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM ecg_readings WHERE athlete_id = ?', [athleteId])?.n ?? 0,
    sleepGoalMin: getHealthSettings(db, athleteId).sleepGoalMin,
    metrics: {
      restingHr: heartMetric(db, athleteId, 'restingHr'),
      hrv: heartMetric(db, athleteId, 'hrv'),
      vo2max: heartMetric(db, athleteId, 'vo2max'),
      steps: heartMetric(db, athleteId, 'steps'),
      heartRate: heartMetric(db, athleteId, 'heartRate'),
    },
  };
}

/**
 * Last day the windows of a metric may use. Cumulative metrics (steps, energy, mindful minutes …) count days without
 * a record as 0, so they end at the last complete day of their own source, judged from the data rather than the
 * clock: an Apple export does not cover the days a COROS sync adds after it, and the day it was taken on holds only
 * the hours before the export. Other metrics end at `asOf`.
 */
function windowEnds(db: Db, athleteId: number, asOf: string): (metric: string, cumulative: boolean) => string {
  const now = nowSec();
  const complete = new Map<RecordFamily, string | null>();
  return (metric, cumulative) => {
    if (!cumulative) return asOf;
    const family = familyOf(metric);
    if (!complete.has(family)) {
      const end = sourceEnd(db, athleteId, family, now);
      complete.set(family, end ? lastCompleteDay(end, now) : null);
    }
    const day = complete.get(family)!;
    return day !== null && day < asOf ? day : asOf;
  };
}

export function buildOverview(db: Db, athleteId: number): HealthOverview {
  const { asOf } = dataRange(db, athleteId);
  if (!asOf) return { asOf: null, cards: [] };
  const windowEnd = windowEnds(db, athleteId, asOf);
  const cards: HealthMetricCard[] = [];
  const settings = getSettings(db, athleteId);
  for (const base of OVERVIEW_METRICS) {
    // resting HR, HRV, VO₂max: Apple's or COROS' values (Settings → My watch)
    const def =
      base.key === 'restingHr' || base.key === 'hrv' || base.key === 'vo2max' || base.key === 'steps'
        ? { ...base, metric: heartMetric(db, athleteId, base.key, settings) }
        : base;
    const firstDay = firstDayOf(db, athleteId, def.metric);
    if (!firstDay) continue;
    const agg = def.metric === 'sleep' ? 'avg' : aggregationOfMetric(db, def.metric);
    const cumulative = agg === 'sum' || agg === 'duration';
    const end = windowEnd(def.metric, cumulative);
    const rows = dailyValues(db, athleteId, def.metric, addDays(end, -(OVERVIEW_SPARK_DAYS - 1)), end);
    const latest = latestValue(db, athleteId, def.metric, end);
    cards.push({
      key: def.key,
      metric: def.metric,
      latestDay: latest?.day ?? null,
      latest: latest?.value ?? null,
      ...summarizeWindows(rows, end, firstDay, cumulative),
      firstDay,
    });
  }
  return { asOf, cards };
}

function snapshotValue(
  db: Db,
  athleteId: number,
  metric: string,
  asOf: string,
  sparkDays: number,
): SnapshotValue | null {
  const latest = latestValue(db, athleteId, metric, asOf);
  if (!latest) return null;
  const rows = dailyValues(db, athleteId, metric, addDays(asOf, -(sparkDays - 1)), asOf);
  const byDay = new Map(rows.map((r) => [r.day, r.value]));
  const spark: (number | null)[] = [];
  for (let i = sparkDays - 1; i >= 0; i--) spark.push(byDay.get(addDays(asOf, -i)) ?? null);
  return { day: latest.day, value: latest.value, spark };
}

export function buildSnapshot(db: Db, athleteId: number): HealthSnapshot {
  const { asOf } = dataRange(db, athleteId);
  if (!asOf) return { asOf: null, restingHr: null, hrv: null, steps: null, sleep: null };
  const sleepBase = snapshotValue(db, athleteId, 'sleep', asOf, 14);
  let sleep: HealthSnapshot['sleep'] = null;
  if (sleepBase) {
    const night = get<{ in_bed_s: number; efficiency: number | null }>(
      db,
      `SELECT in_bed_s, efficiency FROM health_sleep_nights WHERE athlete_id = ? AND kind = 'night' AND day = ?`,
      [athleteId, sleepBase.day],
    );
    sleep = {
      ...sleepBase,
      inBedS: night?.in_bed_s ?? 0,
      efficiency: night?.efficiency ?? null,
      goalMin: getHealthSettings(db, athleteId).sleepGoalMin,
    };
  }
  // Apple's steps of the day an export was taken on are only its morning: show the last complete day instead
  const steps = heartMetric(db, athleteId, 'steps');
  const stepsEnd = windowEnds(db, athleteId, asOf)(steps, aggregationOfMetric(db, steps) === 'sum');
  return {
    asOf,
    restingHr: snapshotValue(db, athleteId, heartMetric(db, athleteId, 'restingHr'), asOf, 14),
    hrv: snapshotValue(db, athleteId, heartMetric(db, athleteId, 'hrv'), asOf, 14),
    steps: snapshotValue(db, athleteId, steps, stepsEnd, 14),
    sleep,
  };
}

/** daily_metrics rows of several metrics at once. */
export function dailyMulti(
  db: Db,
  athleteId: number,
  metrics: string[],
  fromDay: string | undefined,
  toDay: string | undefined,
): Record<string, DailyMetric[]> {
  const out: Record<string, DailyMetric[]> = {};
  for (const metric of metrics) {
    out[metric] = all<DailyMetric>(
      db,
      `SELECT day, value, min, max, n FROM daily_metrics
       WHERE athlete_id = ? AND metric = ? AND day >= ? AND day <= ? ORDER BY day`,
      [athleteId, metric, fromDay ?? '0000-00-00', toDay ?? '9999-12-31'],
    );
  }
  return out;
}
