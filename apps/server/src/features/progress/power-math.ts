/**
 * Pure math of the power curve (no database access) — unit tested in test/progress-power.test.ts.
 *
 * `WorkoutStreams.power` holds the CyclingPower (rides) or RunningPower (runs) records sampled at the stream times:
 * the GPS fixes (~1 s) or a 5 s / 10 s grid for workouts without GPS. `breaks` are the indices where a new part of
 * the track starts after a jump across a pause (train, car); no window may span one.
 */
import { trackParts, type ProgressPowerPeriod } from '@cadence/shared';
import { addDays, parseDay } from '../../lib/time';
import { linearFit, shiftYears } from './math';

// ---------------------------------------------------------------------------
// 1 Hz resampling
// ---------------------------------------------------------------------------

/** Samples outside 0 … MAX_PLAUSIBLE_W are sensor glitches and count as missing. */
export const MAX_PLAUSIBLE_W = 3000;
/**
 * Two neighbouring samples are interpolated when they are at most max(MIN_GAP_S, GAP_FACTOR × the median sample
 * spacing) apart: 5 s for 1 s GPS streams, 7.5 s / 15 s for the 5 s / 10 s grid of workouts without GPS.
 *
 * Every other second counts as 0 W: inside a longer gap (pause, lost signal), next to a missing value, outside the
 * samples. This is conservative on purpose — a best average never contains power that was not measured, so the
 * curve can only underestimate (e.g. a 20-minute window across a short stop), never overestimate.
 */
export const MIN_GAP_S = 5;
export const GAP_FACTOR = 1.5;
const EPS = 1e-6;

export interface PowerPart {
  /** Seconds after the workout start of the first value. */
  startT: number;
  /** Power at 1 Hz (W); seconds without power are 0. */
  watts: Float64Array;
  /** Seconds that carry measured (or interpolated) power. */
  measured: number;
}

/** Median spacing (s) of consecutive samples within the parts (histogram of 0.1 s steps, the stored precision). */
export function medianStep(t: ArrayLike<number>, parts: readonly [number, number][]): number {
  const BINS = 6001; // 0.0 … 600.0 s, the last bin collects longer steps
  const hist = new Uint32Array(BINS);
  let count = 0;
  for (const [a, b] of parts) {
    for (let i = a + 1; i < b; i++) {
      const d = t[i]! - t[i - 1]!;
      if (!(d > 0)) continue;
      const k = Math.min(BINS - 1, Math.round(d * 10));
      hist[k] = hist[k]! + 1;
      count++;
    }
  }
  if (!count) return 1;
  let acc = 0;
  for (let k = 0; k < BINS; k++) {
    acc += hist[k]!;
    if (acc * 2 >= count) return Math.max(0.1, k / 10);
  }
  return 1;
}

/** The stream arrays powerParts reads (WorkoutStreams, or the typed arrays of the activity analysis). */
export interface PowerStream {
  t: ArrayLike<number>;
  power?: ArrayLike<number | null> | null;
  breaks?: ArrayLike<number> | null;
}

/**
 * The power of a workout resampled to 1 Hz, one array per track part (parts split at `breaks`, see trackParts).
 * The grid of a part starts at its first sample; values are linearly interpolated between samples that are at
 * most the interpolation gap apart (see MIN_GAP_S), every other second is 0 W. Parts without any power are dropped.
 * Used for the power curve and the peaks on the activity page.
 */
export function powerParts(st: PowerStream): PowerPart[] {
  const t = st.t;
  const p = st.power;
  const n = t?.length ?? 0;
  if (!p || p.length !== n || n < 2) return [];
  const val = new Float64Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    const v = p[i];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_PLAUSIBLE_W) {
      val[i] = v;
      any = true;
    } else val[i] = NaN;
  }
  if (!any) return [];
  const parts = trackParts(n, st.breaks);
  const maxGap = Math.max(MIN_GAP_S, GAP_FACTOR * medianStep(t, parts));
  const out: PowerPart[] = [];
  for (const [a, b] of parts) {
    if (b - a < 2) continue;
    const t0 = t[a]!;
    const span = t[b - 1]! - t0;
    if (!(span >= 1 - EPS)) continue;
    const len = Math.floor(span + EPS) + 1;
    const w = new Float64Array(len);
    let measured = 0;
    let j = a;
    for (let k = 0; k < len; k++) {
      const x = t0 + k;
      // t[j] <= x <= t[j + 1], j <= b - 2
      while (j < b - 2 && t[j + 1]! <= x + EPS) j++;
      const ta = t[j]!;
      const tb = t[j + 1]!;
      const va = val[j]!;
      const vb = val[j + 1]!;
      let v = NaN;
      if (Math.abs(x - ta) <= EPS) v = va;
      else if (Math.abs(x - tb) <= EPS) v = vb;
      else if (tb - ta <= maxGap && va === va && vb === vb) v = va + ((vb - va) * (x - ta)) / (tb - ta);
      if (v === v) {
        w[k] = v;
        measured++;
      }
    }
    if (measured) out.push({ startT: t0, watts: w, measured });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Best average power per duration
// ---------------------------------------------------------------------------

export interface BestAverage {
  durationS: number;
  /** Best average power (W). */
  watts: number;
  /** Start of the best window in seconds after the workout start. */
  offsetS: number;
}

/**
 * Best average power for every duration that fits into one part: a sliding window over prefix sums, O(n) per
 * duration. Windows never cross from one part into the next (a track break). `durations` must be ascending.
 * Durations whose best is 0 W (no power at all) are left out.
 */
export function bestAverages(parts: readonly PowerPart[], durations: readonly number[]): BestAverage[] {
  const best: (BestAverage | undefined)[] = new Array(durations.length);
  for (const part of parts) {
    const w = part.watts;
    const n = w.length;
    const sum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) sum[i + 1] = sum[i]! + w[i]!;
    for (let k = 0; k < durations.length; k++) {
      const d = durations[k]!;
      if (d > n) break;
      let bi = 0;
      let bs = -1;
      for (let i = 0, last = n - d; i <= last; i++) {
        const s = sum[i + d]! - sum[i]!;
        if (s > bs) {
          bs = s;
          bi = i;
        }
      }
      const watts = bs / d;
      const cur = best[k];
      if (watts > 0 && (!cur || watts > cur.watts))
        best[k] = { durationS: d, watts, offsetS: part.startT + bi };
    }
  }
  return best.filter((b): b is BestAverage => !!b);
}

// ---------------------------------------------------------------------------
// FTP & critical power
// ---------------------------------------------------------------------------

/** FTP estimate = FTP_FACTOR × the best 20-minute power. */
export const FTP_FACTOR = 0.95;
export const FTP_DURATION_S = 1200;
/** Days searched for the 20-minute best: the last 6 weeks, else the last 90 days. */
export const FTP_WINDOWS = [42, 90] as const;

/** Bests between 3 and 20 minutes feed the critical power model. */
export const CP_MIN_S = 180;
export const CP_MAX_S = 1200;
/** …reaching down to 5 minutes and up to 12 minutes, so the slope is well defined. */
const CP_SHORT_S = 300;
const CP_LONG_S = 720;
/** A fit counts as reasonable with R² ≥ 0.99, every best within 5 % of the model and W′ of 2–60 kJ. */
export const CP_MIN_R2 = 0.99;
export const CP_MAX_ERROR = 0.05;
export const CP_WPRIME_J: readonly [number, number] = [2000, 60000];

export interface CriticalPowerFit {
  cpW: number;
  wPrimeJ: number;
  r2: number;
  /** Largest relative deviation between a best and the model's power CP + W′ / t. */
  maxError: number;
  durations: number[];
}

/**
 * Critical power model from best efforts: the work of an all-out effort grows linearly with its duration,
 * work = CP · t + W′ (linear regression of work on time). Only reported when the fit is reasonable: enough bests
 * (≥ 3, from ≤ 5 to ≥ 12 minutes), R² ≥ CP_MIN_R2, every best within CP_MAX_ERROR of the model, plausible W′.
 * Bests that were not all-out (e.g. no hard 3-minute effort in the window) flatten the curve and fail these checks.
 */
export function criticalPowerFit(points: readonly { durationS: number; watts: number }[]): {
  fit: CriticalPowerFit | null;
  issue: 'tooFew' | 'poorFit' | null;
} {
  const pts = points.filter((p) => p.durationS >= CP_MIN_S && p.durationS <= CP_MAX_S && p.watts > 0);
  const ds = pts.map((p) => p.durationS);
  if (pts.length < 3 || Math.min(...ds) > CP_SHORT_S || Math.max(...ds) < CP_LONG_S)
    return { fit: null, issue: 'tooFew' };
  const f = linearFit(
    ds,
    pts.map((p) => p.watts * p.durationS),
  );
  if (!f) return { fit: null, issue: 'tooFew' };
  const cpW = f.slope;
  const wPrimeJ = f.intercept;
  let maxError = 0;
  for (const p of pts)
    maxError = Math.max(maxError, Math.abs(cpW + wPrimeJ / p.durationS - p.watts) / p.watts);
  const ok =
    cpW > 0 &&
    wPrimeJ >= CP_WPRIME_J[0] &&
    wPrimeJ <= CP_WPRIME_J[1] &&
    f.r2 >= CP_MIN_R2 &&
    maxError <= CP_MAX_ERROR;
  if (!ok) return { fit: null, issue: 'poorFit' };
  return { fit: { cpW, wPrimeJ, r2: f.r2, maxError, durations: ds }, issue: null };
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

export interface DayRange {
  fromDay: string;
  toDay: string;
}

/**
 * Day range of a power-curve period. `span` is the first / last day with power data of the sport ('all' covers it,
 * and never ends before today).
 */
export function powerPeriodRange(
  period: ProgressPowerPeriod,
  today: string,
  o: {
    year?: number;
    fromDay?: string;
    toDay?: string;
    span: { firstDay: string | null; lastDay: string | null };
  },
): DayRange {
  switch (period) {
    case '42d':
      return { fromDay: addDays(today, -41), toDay: today };
    case '90d':
      return { fromDay: addDays(today, -89), toDay: today };
    case '12m':
      return { fromDay: addDays(shiftYears(today, -1), 1), toDay: today };
    case 'year': {
      const y = o.year ?? Number(today.slice(0, 4));
      return { fromDay: `${y}-01-01`, toDay: `${y}-12-31` };
    }
    case 'custom':
      if (!o.fromDay || !o.toDay) throw new Error('custom period needs fromDay and toDay');
      return { fromDay: o.fromDay, toDay: o.toDay };
    case 'all': {
      const toDay = o.span.lastDay && o.span.lastDay > today ? o.span.lastDay : today;
      const first = o.span.firstDay ?? today;
      return { fromDay: first < toDay ? first : toDay, toDay };
    }
  }
}

/**
 * The period of the same length right before: the previous calendar year, the 12 months before, or as many days
 * before. Null for 'all'.
 */
export function previousPowerRange(period: ProgressPowerPeriod, r: DayRange): DayRange | null {
  if (period === 'all') return null;
  if (period === 'year') {
    const y = Number(r.fromDay.slice(0, 4)) - 1;
    return { fromDay: `${y}-01-01`, toDay: `${y}-12-31` };
  }
  if (period === '12m')
    return { fromDay: addDays(shiftYears(r.toDay, -2), 1), toDay: shiftYears(r.toDay, -1) };
  const days = parseDay(r.toDay)! - parseDay(r.fromDay)! + 1;
  const toDay = addDays(r.fromDay, -1);
  return { fromDay: addDays(toDay, -(days - 1)), toDay };
}
