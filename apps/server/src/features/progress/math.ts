/**
 * Pure math of the progress feature (no database access) — unit tested in test/progress-math.test.ts.
 *
 * Days are handled as epoch day numbers (days since 1970-01-01, see lib/time.ts) internally and as
 * 'YYYY-MM-DD' strings at the edges.
 */
import type {
  ProgressAcwrStatus,
  ProgressBucket,
  ProgressFormZone,
  ProgressRampStatus,
  ProgressVo2Level,
  WorkoutStreams,
} from '@cadence/shared';
import { dayString, parseDay } from '../../lib/time';

// ---------------------------------------------------------------------------
// Basic statistics
// ---------------------------------------------------------------------------

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Exponentially weighted moving average: e[i] = e[i-1] + alpha · (x[i] − e[i-1]), starting from `seed`.
 * Training-load models use alpha = 1 / timeConstant (CTL: 1/42, ATL: 1/7).
 */
export function ewma(values: readonly number[], alpha: number, seed = 0): number[] {
  const out = new Array<number>(values.length);
  let e = seed;
  for (let i = 0; i < values.length; i++) {
    e += alpha * (values[i]! - e);
    out[i] = e;
  }
  return out;
}

/**
 * Trailing mean over the last `window` entries (nulls are skipped). Null until at least `minCount`
 * values are inside the window.
 */
export function rollingMean(values: readonly (number | null)[], window: number, minCount = window): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (window < 1) return out;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) {
      sum += v;
      n++;
    }
    const old = i - window >= 0 ? values[i - window] : null;
    if (old !== null && old !== undefined && Number.isFinite(old)) {
      sum -= old;
      n--;
    }
    out[i] = n >= minCount && n > 0 ? sum / n : null;
  }
  return out;
}

/** Trailing median over the last `window` values (fewer at the start). */
export function rollingMedian(values: readonly number[], window: number): number[] {
  const out = new Array<number>(values.length);
  const w = Math.max(1, Math.floor(window));
  for (let i = 0; i < values.length; i++) out[i] = median(values.slice(Math.max(0, i - w + 1), i + 1))!;
  return out;
}

/** Trailing mean of `v` over points whose `x` lies within (x[i] − span, x[i]]; x must be ascending. */
export function rollingMeanBySpan(xs: readonly number[], vs: readonly number[], span: number): number[] {
  const out = new Array<number>(xs.length);
  let lo = 0;
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += vs[i]!;
    while (xs[lo]! <= xs[i]! - span) sum -= vs[lo++]!;
    out[i] = sum / (i - lo + 1);
  }
  return out;
}

/** Trailing median of `v` over points whose `x` lies within (x[i] − span, x[i]]; x must be ascending. */
export function rollingMedianBySpan(xs: readonly number[], vs: readonly number[], span: number): number[] {
  const out = new Array<number>(xs.length);
  let lo = 0;
  for (let i = 0; i < xs.length; i++) {
    while (xs[lo]! <= xs[i]! - span) lo++;
    out[i] = median(vs.slice(lo, i + 1))!;
  }
  return out;
}

export interface LinearFit {
  slope: number;
  intercept: number;
  /** Coefficient of determination (0..1). */
  r2: number;
}

/** (Weighted) least-squares line y = intercept + slope · x. Null for < 2 distinct x values. */
export function linearFit(xs: readonly number[], ys: readonly number[], weights?: readonly number[]): LinearFit | null {
  const n = Math.min(xs.length, ys.length);
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i]! : 1;
    if (!(w > 0)) continue;
    sw += w;
    sx += w * xs[i]!;
    sy += w * ys[i]!;
  }
  if (sw <= 0) return null;
  const mx = sx / sw;
  const my = sy / sw;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i]! : 1;
    if (!(w > 0)) continue;
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxx += w * dx * dx;
    sxy += w * dx * dy;
    syy += w * dy * dy;
  }
  if (sxx <= 1e-12) return null;
  const slope = sxy / sxx;
  const r2 = syy > 1e-12 ? Math.min(1, (sxy * sxy) / (sxx * syy)) : 1;
  return { slope, intercept: my - slope * mx, r2 };
}

// ---------------------------------------------------------------------------
// Calendar buckets (epoch day numbers)
// ---------------------------------------------------------------------------

/** 0 = Sunday … 6 = Saturday (1970-01-01 was a Thursday). */
export function weekdayOf(epochDay: number): number {
  return (((epochDay + 4) % 7) + 7) % 7;
}

/** First day of the week containing `epochDay`; weekStart 1 = Monday, 0 = Sunday. */
export function startOfWeek(epochDay: number, weekStart: 0 | 1): number {
  return epochDay - ((weekdayOf(epochDay) - weekStart + 7) % 7);
}

export function mustParseDay(day: string): number {
  const d = parseDay(day);
  if (d === null) throw new Error(`Invalid day ${day}`);
  return d;
}

/** Bucket key of a day: week start day 'YYYY-MM-DD', 'YYYY-MM' or 'YYYY'. */
export function bucketKey(day: string, bucket: ProgressBucket, weekStart: 0 | 1): string {
  if (bucket === 'week') return dayString(startOfWeek(mustParseDay(day), weekStart));
  if (bucket === 'month') return day.slice(0, 7);
  return day.slice(0, 4);
}

export interface BucketRange {
  key: string;
  fromDay: string;
  toDay: string;
}

function lastDayOfMonth(y: number, m: number): number {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * Contiguous buckets covering [fromDay, toDay]. Each bucket spans its full calendar period (a week can start
 * before fromDay); the caller clips the data, not the bucket.
 */
export function bucketsBetween(fromDay: string, toDay: string, bucket: ProgressBucket, weekStart: 0 | 1): BucketRange[] {
  const out: BucketRange[] = [];
  const a = mustParseDay(fromDay);
  const b = mustParseDay(toDay);
  if (b < a) return out;
  if (bucket === 'week') {
    for (let d = startOfWeek(a, weekStart); d <= b; d += 7)
      out.push({ key: dayString(d), fromDay: dayString(d), toDay: dayString(d + 6) });
    return out;
  }
  let y = Number(fromDay.slice(0, 4));
  let m = Number(fromDay.slice(5, 7));
  const ey = Number(toDay.slice(0, 4));
  const em = Number(toDay.slice(5, 7));
  if (bucket === 'year') {
    for (; y <= ey; y++) out.push({ key: String(y), fromDay: `${y}-01-01`, toDay: `${y}-12-31` });
    return out;
  }
  while (y < ey || (y === ey && m <= em)) {
    const mm = String(m).padStart(2, '0');
    out.push({ key: `${y}-${mm}`, fromDay: `${y}-${mm}-01`, toDay: `${y}-${mm}-${lastDayOfMonth(y, m)}` });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** Slot 0..365 of a day in a leap reference year (Feb 29 = 59), so years align by calendar date. */
export function referenceDayIndex(day: string): number {
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  const cum = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  return cum[m - 1]! + d - 1;
}

/** The same calendar date `years` earlier/later (Feb 29 → Feb 28 in non-leap years). */
export function shiftYears(day: string, years: number): string {
  const y = Number(day.slice(0, 4)) + years;
  const m = Number(day.slice(5, 7));
  const d = Math.min(Number(day.slice(8, 10)), lastDayOfMonth(y, m));
  return `${y}-${day.slice(5, 7)}-${String(d).padStart(2, '0')}`;
}

/** The same day of month `months` earlier/later, clamped to the month's length. */
export function shiftMonths(day: string, months: number): string {
  let y = Number(day.slice(0, 4));
  let m = Number(day.slice(5, 7)) + months;
  y += Math.floor((m - 1) / 12);
  m = ((((m - 1) % 12) + 12) % 12) + 1;
  const d = Math.min(Number(day.slice(8, 10)), lastDayOfMonth(y, m));
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function endOfMonth(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return `${day.slice(0, 7)}-${lastDayOfMonth(y, m)}`;
}

// ---------------------------------------------------------------------------
// Race prediction
// ---------------------------------------------------------------------------

export const RIEGEL_EXPONENT = 1.06;

/** Riegel's endurance model: time for distance d2 from a performance (t1 over d1). */
export function riegel(t1: number, d1: number, d2: number, exponent = RIEGEL_EXPONENT): number {
  return t1 * (d2 / d1) ** exponent;
}

/** Daniels/Gilbert oxygen cost (ml/kg/min) of running at `v` meters per minute. */
export function danielsVo2(vMetersPerMin: number): number {
  return -4.6 + 0.182258 * vMetersPerMin + 0.000104 * vMetersPerMin * vMetersPerMin;
}

/** Daniels/Gilbert fraction of VO2max that can be sustained for `minutes`. */
export function danielsFraction(minutes: number): number {
  return 0.8 + 0.1894393 * Math.exp(-0.012778 * minutes) + 0.2989558 * Math.exp(-0.1932605 * minutes);
}

/** VDOT of a race performance (distance m in seconds). */
export function vdotFromPerformance(distanceM: number, seconds: number): number {
  const min = seconds / 60;
  return danielsVo2(distanceM / min) / danielsFraction(min);
}

/** Race time (s) over `distanceM` for a VDOT (≈ VO2max), by bisection on the Daniels/Gilbert equations. */
export function timeFromVdot(vdot: number, distanceM: number): number | null {
  if (!(vdot > 10) || !(distanceM > 0)) return null;
  // vdotFromPerformance falls monotonically with time
  let lo = 60 * Math.max(0.5, distanceM / 600); // > 36 km/h: faster than anyone
  let hi = 60 * (distanceM / 40); // 2.4 km/h
  if (vdotFromPerformance(distanceM, lo) < vdot || vdotFromPerformance(distanceM, hi) > vdot) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (vdotFromPerformance(distanceM, mid) > vdot) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Training load (fitness / fatigue / form)
// ---------------------------------------------------------------------------

export const CTL_DAYS = 42;
export const ATL_DAYS = 7;

export interface LoadDay {
  ctl: number;
  atl: number;
  tsb: number;
  ramp: number;
  acwr: number | null;
}

/**
 * Banister/Coggan performance model over a contiguous series of daily loads (missing days = 0):
 * CTL = EWMA(1/42), ATL = EWMA(1/7), TSB = CTL − ATL, ramp = CTL − CTL 7 days earlier,
 * ACWR = mean(load, 7 d) / mean(load, 28 d) (null while the chronic mean is ~0).
 */
export function trainingLoad(loads: readonly number[], ctlDays = CTL_DAYS, atlDays = ATL_DAYS): LoadDay[] {
  const ctl = ewma(loads, 1 / ctlDays);
  const atl = ewma(loads, 1 / atlDays);
  const acute = rollingMean(loads, 7, 1);
  const chronic = rollingMean(loads, 28, 1);
  return loads.map((_, i) => {
    const c = chronic[i] ?? 0;
    return {
      ctl: ctl[i]!,
      atl: atl[i]!,
      tsb: ctl[i]! - atl[i]!,
      ramp: ctl[i]! - (i >= 7 ? ctl[i - 7]! : 0),
      acwr: c > 1 ? (acute[i] ?? 0) / c : null,
    };
  });
}

/** TSB bounds of the form zones (upper zones first). */
export const FORM_ZONE_BOUNDS: { key: ProgressFormZone; min: number | null; max: number | null }[] = [
  { key: 'transition', min: 25, max: null },
  { key: 'fresh', min: 5, max: 25 },
  { key: 'optimal', min: -10, max: 5 },
  { key: 'tired', min: -30, max: -10 },
  { key: 'overreaching', min: null, max: -30 },
];

export function formZone(tsb: number): ProgressFormZone {
  for (const z of FORM_ZONE_BOUNDS) if (z.min === null || tsb >= z.min) return z.key;
  return 'overreaching';
}

export const RAMP_ELEVATED = 5;
export const RAMP_HIGH = 8;

/** Weekly fitness ramp: > 5 per week is aggressive, > 8 per week a common injury warning sign. */
export function rampStatus(ramp: number): ProgressRampStatus {
  return ramp >= RAMP_HIGH ? 'high' : ramp >= RAMP_ELEVATED ? 'elevated' : 'normal';
}

export const ACWR_LOW = 0.8;
export const ACWR_HIGH = 1.3;
export const ACWR_DANGER = 1.5;

/** Acute:chronic workload ratio: 0.8–1.3 is the "sweet spot", above 1.5 the injury risk climbs. */
export function acwrStatus(acwr: number | null): ProgressAcwrStatus | null {
  if (acwr === null) return null;
  if (acwr < ACWR_LOW) return 'low';
  if (acwr <= ACWR_HIGH) return 'optimal';
  if (acwr <= ACWR_DANGER) return 'elevated';
  return 'high';
}

// ---------------------------------------------------------------------------
// VO2max fitness levels
// ---------------------------------------------------------------------------

/**
 * VO2max (ml/kg/min) at the 20th, 40th, 60th and 80th percentile by age band (ACSM's Guidelines / Cooper
 * Institute treadmill norms, rounded). Below the 20th = poor, then fair, good, excellent, ≥ 80th = superior.
 */
const VO2_NORMS: Record<'male' | 'female', { maxAge: number; cut: [number, number, number, number] }[]> = {
  male: [
    { maxAge: 29, cut: [38.1, 42.2, 45.7, 51.1] },
    { maxAge: 39, cut: [36.7, 41.0, 44.4, 48.9] },
    { maxAge: 49, cut: [34.6, 38.4, 42.4, 46.8] },
    { maxAge: 59, cut: [31.1, 35.2, 38.3, 43.3] },
    { maxAge: 69, cut: [27.4, 31.4, 35.0, 39.5] },
    { maxAge: 200, cut: [24.9, 28.1, 31.4, 36.0] },
  ],
  female: [
    { maxAge: 29, cut: [32.3, 36.1, 39.5, 44.0] },
    { maxAge: 39, cut: [30.5, 34.0, 37.0, 41.0] },
    { maxAge: 49, cut: [28.3, 32.0, 35.1, 39.0] },
    { maxAge: 59, cut: [25.5, 28.7, 31.4, 35.2] },
    { maxAge: 69, cut: [23.7, 26.6, 29.1, 32.3] },
    { maxAge: 200, cut: [21.7, 24.6, 27.3, 30.2] },
  ],
};

const LEVELS: ProgressVo2Level[] = ['poor', 'fair', 'good', 'excellent', 'superior'];

/** Level bands for an age and sex ('other'/unknown sex: mean of both tables). Null for unknown age. */
export function vo2Levels(
  age: number | null,
  sex: string | null,
): { key: ProgressVo2Level; min: number | null; max: number | null }[] | null {
  if (age === null || !Number.isFinite(age)) return null;
  const a = Math.max(18, age);
  const pick = (s: 'male' | 'female') => VO2_NORMS[s].find((r) => a <= r.maxAge)!.cut;
  const cut =
    sex === 'male' || sex === 'female'
      ? pick(sex)
      : (pick('male').map((v, i) => Math.round(((v + pick('female')[i]!) / 2) * 10) / 10) as [number, number, number, number]);
  return LEVELS.map((key, i) => ({ key, min: i === 0 ? null : cut[i - 1]!, max: i === 4 ? null : cut[i]! }));
}

export function vo2Level(value: number, levels: { key: ProgressVo2Level; min: number | null }[]): ProgressVo2Level {
  let out = levels[0]!.key;
  for (const l of levels) if (l.min === null || value >= l.min) out = l.key;
  return out;
}

// ---------------------------------------------------------------------------
// Streams → pace at heart rate, aerobic decoupling
// ---------------------------------------------------------------------------

/** Moving seconds and meters per integer bpm, starting at bpm `lo`. */
export interface HrSpeedHistogram {
  lo: number;
  s: number[];
  d: number[];
}

export interface StreamFilter {
  /** Ignore the first seconds of the workout (heart rate still catching up). */
  skipS: number;
  /** Plausible speed range in m/s (below = standing, above = GPS glitch). */
  minSpeed: number;
  maxSpeed: number;
}

interface Sample {
  dt: number;
  dd: number;
  hr: number;
}

/** Moving samples with heart rate and speed, in stream order (dt ≤ 30 s, after the warm-up skip). */
function movingSamples(st: WorkoutStreams, f: StreamFilter): Sample[] {
  const { t, hr, moving, dist, speed } = st;
  const out: Sample[] = [];
  if (!hr || t.length < 2 || (!dist && !speed)) return out;
  const t0 = t[0]!;
  for (let i = 1; i < t.length; i++) {
    const dt = t[i]! - t[i - 1]!;
    if (!(dt > 0) || dt > 30 || t[i]! - t0 < f.skipS) continue;
    if (moving && !moving[i]) continue;
    const h = hr[i];
    if (h === null || h === undefined || h < 40 || h > 230) continue;
    const v = speed?.[i] ?? (dist ? (dist[i]! - dist[i - 1]!) / dt : null);
    if (v === null || v === undefined || !(v >= f.minSpeed) || v > f.maxSpeed) continue;
    const dd = dist ? dist[i]! - dist[i - 1]! : v * dt;
    if (!(dd >= 0)) continue;
    out.push({ dt, dd, hr: h });
  }
  return out;
}

/** Time and distance spent at each heart rate while moving (basis of "pace at heart rate"). */
export function hrSpeedHistogram(st: WorkoutStreams, f: StreamFilter): HrSpeedHistogram | null {
  const samples = movingSamples(st, f);
  if (!samples.length) return null;
  const s = new Float64Array(256);
  const d = new Float64Array(256);
  for (const x of samples) {
    const b = Math.round(x.hr);
    s[b]! += x.dt;
    d[b]! += x.dd;
  }
  let lo = 0;
  while (lo < 256 && s[lo] === 0) lo++;
  let hi = 255;
  while (hi > lo && s[hi] === 0) hi--;
  if (lo >= 256) return null;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return { lo, s: Array.from(s.subarray(lo, hi + 1), r1), d: Array.from(d.subarray(lo, hi + 1), r1) };
}

/** Seconds and meters of a histogram inside the band lo ≤ bpm < hi. */
export function bandTotals(h: HrSpeedHistogram, lo: number, hi: number): { seconds: number; meters: number } {
  let seconds = 0;
  let meters = 0;
  const a = Math.max(lo, h.lo);
  const b = Math.min(hi, h.lo + h.s.length);
  for (let bpm = a; bpm < b; bpm++) {
    seconds += h.s[bpm - h.lo]!;
    meters += h.d[bpm - h.lo]!;
  }
  return { seconds, meters };
}

/** Sum of several histograms (e.g. a whole month) as seconds per bpm from `lo`. */
export function mergeHistograms(list: readonly HrSpeedHistogram[]): { lo: number; seconds: number[] } | null {
  if (!list.length) return null;
  const lo = Math.min(...list.map((h) => h.lo));
  const hi = Math.max(...list.map((h) => h.lo + h.s.length));
  const seconds = new Array<number>(hi - lo).fill(0);
  for (const h of list) for (let i = 0; i < h.s.length; i++) seconds[h.lo - lo + i]! += h.s[i]!;
  return { lo, seconds: seconds.map((x) => Math.round(x)) };
}

/** The `width` bpm band with the most time (ties → the lower band). */
export function mostCommonBand(dist: { lo: number; seconds: number[] }, width = 10): { lo: number; hi: number } | null {
  const { lo, seconds } = dist;
  let best = -1;
  let bestLo = lo;
  for (let a = 0; a < seconds.length; a++) {
    let sum = 0;
    for (let k = a; k < Math.min(seconds.length, a + width); k++) sum += seconds[k]!;
    if (sum > best) {
      best = sum;
      bestLo = lo + a;
    }
  }
  if (best <= 0) return null;
  // align to 5 bpm so the band reads naturally (e.g. 140–150)
  const start = Math.round(bestLo / 5) * 5;
  return { lo: start, hi: start + width };
}

/**
 * Aerobic decoupling (Pa:HR, %): how much the speed-per-heartbeat ratio drops from the first to the second
 * half of the moving time. < 5 % = good aerobic endurance. Null for short or HR-less workouts.
 */
export function aerobicDecoupling(st: WorkoutStreams, f: StreamFilter, minMovingS = 2400): number | null {
  const samples = movingSamples(st, f);
  let total = 0;
  for (const x of samples) total += x.dt;
  if (total < minMovingS) return null;
  const half = total / 2;
  const acc = [
    { d: 0, hb: 0 },
    { d: 0, hb: 0 },
  ];
  let tCum = 0;
  for (const x of samples) {
    const k = tCum < half ? 0 : 1;
    acc[k]!.d += x.dd;
    acc[k]!.hb += x.hr * x.dt;
    tCum += x.dt;
  }
  if (!(acc[0]!.hb > 0) || !(acc[1]!.hb > 0)) return null;
  const ef1 = acc[0]!.d / acc[0]!.hb;
  const ef2 = acc[1]!.d / acc[1]!.hb;
  if (!(ef1 > 0)) return null;
  return ((ef1 - ef2) / ef1) * 100;
}
