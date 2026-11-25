import {
  PROGRESS_TREND_METRICS,
  sportInfo,
  type PaceAtHrMonth,
  type PaceAtHrResponse,
  type ProgressHrBand,
  type ProgressIntensityResponse,
  type ProgressPreferences,
  type ProgressTrendFit,
  type ProgressTrendMetric,
  type ProgressTrendSeries,
  type ProgressTrendWorkout,
  type ProgressTrendsResponse,
} from '@cadence/shared';
import { all, json, type Db } from '../../db/db';
import { getSetting } from '../../core/settings';
import { localDay } from '../../lib/time';
import { currentAnalysisSql } from '../activities/store';
import { dayTs, visibleWorkoutsInDays, weekStartOf, zoneBoundsOf } from './common';
import {
  bandTotals,
  bucketKey,
  bucketsBetween,
  linearFit,
  mergeHistograms,
  mostCommonBand,
  rollingMedian,
  type HrSpeedHistogram,
} from './math';
import { ensureWorkoutMetrics } from './workout-metrics';

// ---------------------------------------------------------------------------
// Per-activity trends
// ---------------------------------------------------------------------------

interface TrendRow {
  id: number;
  name: string;
  sport: string;
  start_ts: number;
  tz_min: number;
  distance_m: number | null;
  moving_s: number | null;
  duration_s: number;
  avg_speed: number | null;
  avg_hr: number | null;
  avg_cadence: number | null;
  avg_power: number | null;
  stride_m: number | null;
  gct_ms: number | null;
  vo_m: number | null;
  /** From the activity analysis: the values the activity page shows. */
  decoupling_pct: number | null;
  pace_efficiency: number | null;
}

interface MetricDef {
  unit: (sport: string) => string;
  better: (sport: string) => 'up' | 'down' | null;
  changeKind: 'relative' | 'absolute';
  value: (r: TrendRow, sport: string) => number | null;
}

const MIN_MOVING_S = 300;

const between = (v: number | null, lo: number, hi: number) => (v !== null && v >= lo && v <= hi ? v : null);
const isCycle = (sport: string) => sportInfo(sport).group === 'cycle';

function speedOf(r: TrendRow, sport: string): number | null {
  if (!sportInfo(sport).distance) return null;
  const moving = r.moving_s ?? r.duration_s;
  if (!r.avg_speed || !r.distance_m || r.distance_m < 500 || moving < MIN_MOVING_S) return null;
  return r.avg_speed > 0 ? r.avg_speed : null;
}

function hrOf(r: TrendRow): number | null {
  if ((r.moving_s ?? r.duration_s) < MIN_MOVING_S) return null;
  return between(r.avg_hr, 60, 220);
}

export const TREND_DEFS: Record<ProgressTrendMetric, MetricDef> = {
  speed: { unit: () => 'm/s', better: () => 'up', changeKind: 'relative', value: speedOf },
  hr: { unit: () => 'bpm', better: () => null, changeKind: 'relative', value: (r) => hrOf(r) },
  // efficiency factor of the activity analysis: (grade adjusted) speed per heartbeat, also for rides with power
  ef: { unit: () => 'm/beat', better: () => 'up', changeKind: 'relative', value: (r) => r.pace_efficiency },
  cadence: {
    unit: (s) => (isCycle(s) ? 'rpm' : 'spm'),
    better: (s) => (sportInfo(s).group === 'foot' ? 'up' : null),
    changeKind: 'relative',
    value: (r) => between(r.avg_cadence, 20, 250),
  },
  power: { unit: () => 'W', better: () => 'up', changeKind: 'relative', value: (r) => between(r.avg_power, 20, 1500) },
  stride: { unit: () => 'm', better: () => 'up', changeKind: 'relative', value: (r) => r.stride_m },
  gct: { unit: () => 'ms', better: () => 'down', changeKind: 'relative', value: (r) => r.gct_ms },
  vo: { unit: () => 'm', better: () => 'down', changeKind: 'relative', value: (r) => r.vo_m },
  decoupling: { unit: () => '%', better: () => 'down', changeKind: 'absolute', value: (r) => r.decoupling_pct },
};

/** Rolling-median window: ~1/10 of the points, between 5 and 15 activities. */
export function medianWindowFor(n: number): number {
  return Math.max(5, Math.min(15, Math.round(n / 10)));
}

/** Least-squares trend over time; needs ≥ 5 points over ≥ 14 days. */
export function trendFit(ts: readonly number[], values: readonly number[], weights?: readonly number[]): ProgressTrendFit | null {
  if (ts.length < 3) return null;
  const t0 = ts[0]!;
  const t1 = ts[ts.length - 1]!;
  if (t1 - t0 < 14 * 86400) return null;
  const fit = linearFit(
    ts.map((t) => (t - t0) / 86400),
    values,
    weights,
  );
  if (!fit) return null;
  const at = (t: number) => fit.intercept + fit.slope * ((t - t0) / 86400);
  return {
    slopePerDay: fit.slope,
    startTs: t0,
    endTs: t1,
    startValue: at(t0),
    endValue: at(t1),
    r2: Math.round(fit.r2 * 1000) / 1000,
  };
}

/** Relative or absolute change of a fit, and whether it is an improvement (null = neutral / stable). */
export function trendChange(
  fit: ProgressTrendFit | null,
  kind: 'relative' | 'absolute',
  better: 'up' | 'down' | null,
): { change: number | null; improved: boolean | null } {
  if (!fit) return { change: null, improved: null };
  let change: number | null;
  if (kind === 'absolute') change = fit.endValue - fit.startValue;
  else change = Math.abs(fit.startValue) > 1e-9 ? (fit.endValue - fit.startValue) / Math.abs(fit.startValue) : null;
  if (change === null || !Number.isFinite(change)) return { change: null, improved: null };
  const stable = kind === 'absolute' ? Math.abs(change) < 0.5 : Math.abs(change) < 0.01;
  return { change, improved: better === null || stable ? null : better === 'up' ? change > 0 : change < 0 };
}

export function trends(
  db: Db,
  athleteId: number,
  q: { sport: string; fromDay: string; toDay: string },
): ProgressTrendsResponse {
  ensureWorkoutMetrics(db, athleteId, q.sport);
  const { where, params } = visibleWorkoutsInDays('w', athleteId, q.sport, q.fromDay, q.toDay);
  const rows = all<TrendRow>(
    db,
    `SELECT w.id, w.name, w.sport, w.start_ts, w.tz_min, w.distance_m, w.moving_s, w.duration_s, w.avg_speed,
       w.avg_hr, w.avg_cadence, w.avg_power, m.stride_m, m.gct_ms, m.vo_m, a.decoupling_pct, a.pace_efficiency
     FROM workouts w LEFT JOIN progress_workout_metrics m ON m.workout_id = w.id
       LEFT JOIN activities_analysis a ON a.workout_id = w.id AND ${currentAnalysisSql('a')}
     WHERE ${where} ORDER BY w.start_ts, w.id`,
    params,
  );
  const workouts: ProgressTrendWorkout[] = [];
  const used = new Map<number, number>();
  const series: ProgressTrendSeries[] = [];
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  for (const metric of PROGRESS_TREND_METRICS) {
    const def = TREND_DEFS[metric];
    const pts: { row: TrendRow; v: number }[] = [];
    for (const r of rows) {
      const v = def.value(r, q.sport);
      if (v !== null && Number.isFinite(v)) pts.push({ row: r, v });
    }
    if (!pts.length) continue;
    const points: [number, number][] = pts.map(({ row, v }) => {
      let i = used.get(row.id);
      if (i === undefined) {
        i = workouts.length;
        used.set(row.id, i);
        workouts.push({
          id: row.id,
          name: row.name,
          sport: row.sport,
          startTs: row.start_ts,
          tzMin: row.tz_min,
          distanceM: row.distance_m,
          movingS: Math.round(row.moving_s ?? row.duration_s),
        });
      }
      return [i, r4(v)];
    });
    const values = pts.map((p) => p.v);
    const window = medianWindowFor(values.length);
    const fit = values.length >= 5 ? trendFit(pts.map((p) => p.row.start_ts), values) : null;
    const better = def.better(q.sport);
    const { change, improved } = trendChange(fit, def.changeKind, better);
    series.push({
      metric,
      unit: def.unit(q.sport),
      better,
      points,
      median: rollingMedian(values, window).map(r4),
      medianWindow: window,
      fit: fit && { ...fit, startValue: r4(fit.startValue), endValue: r4(fit.endValue) },
      change: change === null ? null : Math.round(change * 1e4) / 1e4,
      changeKind: def.changeKind,
      improved,
    });
  }
  return { sport: q.sport, workouts, series };
}

// ---------------------------------------------------------------------------
// Pace at heart rate
// ---------------------------------------------------------------------------

export const PACE_AT_HR_MIN_SECONDS = 300;
const PREFS_KEY = 'progress.preferences';

export function getPreferences(db: Db, athleteId: number): ProgressPreferences {
  const p = getSetting<Partial<ProgressPreferences>>(db, athleteId, PREFS_KEY, {});
  return { hrBands: p.hrBands && typeof p.hrBands === 'object' ? p.hrBands : {} };
}

export const PREFERENCES_KEY = PREFS_KEY;

export function paceAtHr(
  db: Db,
  athleteId: number,
  q: { sport: string; fromDay: string; toDay: string; lo?: number; hi?: number },
): PaceAtHrResponse {
  ensureWorkoutMetrics(db, athleteId, q.sport);
  const { where, params } = visibleWorkoutsInDays('w', athleteId, q.sport, q.fromDay, q.toDay);
  const rows = all<{ start_ts: number; tz_min: number; hr_speed: string }>(
    db,
    `SELECT w.start_ts, w.tz_min, m.hr_speed FROM workouts w JOIN progress_workout_metrics m ON m.workout_id = w.id
     WHERE ${where} AND m.hr_speed IS NOT NULL ORDER BY w.start_ts`,
    params,
  );
  const items = rows
    .map((r) => ({ month: localDay(r.start_ts, r.tz_min).slice(0, 7), h: json<HrSpeedHistogram | null>(r.hr_speed, null) }))
    .filter((x): x is { month: string; h: HrSpeedHistogram } => !!x.h && Array.isArray(x.h.s));
  const distribution = mergeHistograms(items.map((x) => x.h));

  const saved = getPreferences(db, athleteId).hrBands[q.sport] ?? null;
  const common = distribution ? mostCommonBand(distribution, 10) : null;
  const zb = zoneBoundsOf(db, athleteId);
  const suggestions: PaceAtHrResponse['suggestions'] = [];
  if (saved) suggestions.push({ key: 'saved', ...saved });
  if (common) suggestions.push({ key: 'common', ...common });
  if (zb.length === 4) {
    suggestions.push({ key: 'z2', lo: zb[0]!, hi: zb[1]! });
    suggestions.push({ key: 'z3', lo: zb[1]!, hi: zb[2]! });
  }
  let band: ProgressHrBand;
  if (q.lo !== undefined && q.hi !== undefined && q.hi > q.lo) band = { lo: q.lo, hi: q.hi };
  else band = saved ?? common ?? (zb.length === 4 ? { lo: zb[0]!, hi: zb[1]! } : { lo: 130, hi: 140 });

  const acc = new Map<string, { s: number; d: number; n: number }>();
  for (const { month, h } of items) {
    const { seconds, meters } = bandTotals(h, band.lo, band.hi);
    if (seconds <= 0) continue;
    const a = acc.get(month) ?? { s: 0, d: 0, n: 0 };
    a.s += seconds;
    a.d += meters;
    if (seconds >= 60) a.n++;
    acc.set(month, a);
  }
  const months: PaceAtHrMonth[] = bucketsBetween(q.fromDay, q.toDay, 'month', 1).map((b) => {
    const a = acc.get(b.key);
    return {
      month: b.key,
      speed: a && a.s >= PACE_AT_HR_MIN_SECONDS ? Math.round((a.d / a.s) * 1000) / 1000 : null,
      seconds: Math.round(a?.s ?? 0),
      distanceM: Math.round(a?.d ?? 0),
      workouts: a?.n ?? 0,
    };
  });
  const valid = months.filter((m) => m.speed !== null);
  // x = middle of the month, weighted by the time spent in the band
  const fit =
    valid.length >= 3
      ? trendFit(
          valid.map((m) => dayTs(`${m.month}-15`)),
          valid.map((m) => m.speed!),
          valid.map((m) => Math.sqrt(m.seconds)),
        )
      : null;
  const { change } = trendChange(fit, 'relative', 'up');
  return {
    sport: q.sport,
    band,
    suggestions,
    hrDistribution: distribution,
    months,
    fit,
    change: change === null ? null : Math.round(change * 1e4) / 1e4,
    minSeconds: PACE_AT_HR_MIN_SECONDS,
  };
}

// ---------------------------------------------------------------------------
// Intensity distribution (time in HR zones)
// ---------------------------------------------------------------------------

export function intensity(
  db: Db,
  athleteId: number,
  q: { sport: string | null; bucket: 'week' | 'month'; fromDay: string; toDay: string },
): ProgressIntensityResponse {
  const weekStart = weekStartOf(db, athleteId);
  const buckets = bucketsBetween(q.fromDay, q.toDay, q.bucket, weekStart).map((b) => ({
    ...b,
    zones: [0, 0, 0, 0, 0],
    total: 0,
    easyShare: null as number | null,
  }));
  const index = new Map(buckets.map((b, i) => [b.key, i]));
  const from = buckets[0]?.fromDay ?? q.fromDay;
  const { where, params } = visibleWorkoutsInDays('', athleteId, q.sport, from, q.toDay);
  const rows = all<{ start_ts: number; tz_min: number; hr_zones: string | null }>(
    db,
    `SELECT start_ts, tz_min, hr_zones FROM workouts WHERE ${where}`,
    params,
  );
  const totals = [0, 0, 0, 0, 0];
  let withZones = 0;
  for (const r of rows) {
    const z = json<number[] | null>(r.hr_zones, null);
    if (!z || z.length !== 5 || !z.some((x) => x > 0)) continue;
    const i = index.get(bucketKey(localDay(r.start_ts, r.tz_min), q.bucket, weekStart));
    if (i === undefined) continue;
    withZones++;
    const b = buckets[i]!;
    for (let k = 0; k < 5; k++) {
      b.zones[k]! += z[k]!;
      totals[k]! += z[k]!;
    }
  }
  const share = (z: number[], from: number, to: number) => {
    const total = z.reduce((a, b) => a + b, 0);
    return total > 0 ? z.slice(from, to).reduce((a, b) => a + b, 0) / total : null;
  };
  for (const b of buckets) {
    b.total = b.zones.reduce((a, c) => a + c, 0);
    b.easyShare = share(b.zones, 0, 2);
  }
  const total = totals.reduce((a, b) => a + b, 0);
  return {
    bucket: q.bucket,
    zoneBounds: zoneBoundsOf(db, athleteId),
    buckets,
    totals: { zones: totals, total, easyShare: share(totals, 0, 2), hardShare: share(totals, 2, 5) },
    coverage: { withZones, workouts: rows.length },
  };
}
