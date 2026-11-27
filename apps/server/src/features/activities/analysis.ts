/**
 * Activity analysis computed from a workout's streams (pure functions, no database access):
 * grade adjusted pace, aerobic decoupling, efficiency factor, power (NP, peaks), climbs and laps.
 *
 * Arrays follow the core stream convention: `t` = seconds since the workout start, sample i closes the segment
 * (i−1 → i) and `moving[i]` tells whether that segment counts as moving time. NaN = missing value.
 */
import {
  GAP_SPORTS,
  climbCategory,
  gradeCostFactor,
  sportInfo,
  type ActivityAnalysis,
  type ActivityClimb,
  type ActivityDecoupling,
  type ActivityEfficiency,
  type ActivityLap,
  type ActivityPower,
  type WorkoutStreams,
  stitchElevation,
  trackParts,
} from '@cadence/shared';
import { smooth } from '../../derive/streams';
import { bestAverages, MAX_PLAUSIBLE_W, powerParts } from '../progress/power-math';

export interface Series {
  n: number;
  t: Float64Array;
  dist: Float64Array | null;
  ele: Float64Array | null;
  speed: Float64Array | null;
  hr: Float64Array | null;
  cadence: Float64Array | null;
  power: Float64Array | null;
  moving: Uint8Array;
  /** Indices where a new part of the GPS track starts (WorkoutStreams.breaks). */
  breaks: number[];
}

export interface AnalysisEvent {
  type: string;
  /** Unix seconds. */
  ts: number;
  durationS: number | null;
  meta: Record<string, string> | null;
}

export interface AnalysisInput {
  sport: string;
  startTs: number;
  endTs: number;
  lapLengthM: number | null;
  streams: WorkoutStreams;
  events: AnalysisEvent[];
}

export type AnalysisResult = Omit<ActivityAnalysis, 'workoutId' | 'computedAt'>;

/** Longest gap (s) a single segment may contribute to moving time (same cap as core). */
const MAX_SEGMENT_S = 600;
/** Longest gap (s) a single segment may contribute to a time-weighted mean. */
const MAX_WEIGHT_S = 30;
/** Elevation grid resolution (m) for grades and climbs. */
export const GRID_STEP_M = 10;

const isNum = (x: number) => x === x;

/** Typed copy of a stream array; values outside [lo, hi] count as missing (NaN). */
function floatArray(a: (number | null)[] | undefined, n: number, lo = -Infinity, hi = Infinity): Float64Array | null {
  if (!a || a.length !== n) return null;
  const out = new Float64Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    const v = a[i];
    if (v === null || v === undefined || !Number.isFinite(v) || v < lo || v > hi) out[i] = NaN;
    else {
      out[i] = v;
      any = true;
    }
  }
  return any ? out : null;
}

/**
 * Typed arrays from the stream DTO (missing/mismatched arrays become null). Power outside 0 … MAX_PLAUSIBLE_W is a
 * sensor glitch and counts as missing, as in the power curve.
 */
export function toSeries(s: WorkoutStreams): Series {
  const n = s.t.length;
  const t = Float64Array.from(s.t);
  const moving = new Uint8Array(n);
  if (s.moving && s.moving.length === n) for (let i = 0; i < n; i++) moving[i] = s.moving[i] ? 1 : 0;
  else moving.fill(1);
  return {
    n,
    t,
    dist: floatArray(s.dist, n),
    ele: floatArray(s.ele, n),
    speed: floatArray(s.speed, n),
    hr: floatArray(s.hr, n),
    cadence: floatArray(s.cadence, n),
    power: floatArray(s.power, n, 0, MAX_PLAUSIBLE_W),
    moving,
    breaks: s.breaks ?? [],
  };
}

/** Value over segment (i−1 → i): mean of both ends, or the one that exists. */
function segValue(a: Float64Array, i: number): number {
  const x = a[i - 1]!;
  const y = a[i]!;
  if (isNum(x) && isNum(y)) return (x + y) / 2;
  return isNum(x) ? x : y;
}

function segDt(s: Series, i: number): number {
  return Math.min(Math.max(0, s.t[i]! - s.t[i - 1]!), MAX_SEGMENT_S);
}

export function movingSeconds(s: Series): number {
  let m = 0;
  for (let i = 1; i < s.n; i++) if (s.moving[i]) m += segDt(s, i);
  return m;
}

/** Time-weighted mean of `a` over moving segments; `seconds` = time covered by valid values. */
export function movingMean(s: Series, a: Float64Array | null): { mean: number | null; seconds: number } {
  if (!a) return { mean: null, seconds: 0 };
  let sum = 0;
  let w = 0;
  for (let i = 1; i < s.n; i++) {
    if (!s.moving[i]) continue;
    const v = segValue(a, i);
    if (!isNum(v)) continue;
    const dt = Math.min(segDt(s, i), MAX_WEIGHT_S);
    sum += v * dt;
    w += dt;
  }
  return { mean: w > 0 ? sum / w : null, seconds: w };
}

/** Moving time with the same per-segment cap as the weights of movingMean (compare coverage like with like). */
function weightedMovingSeconds(s: Series): number {
  let m = 0;
  for (let i = 1; i < s.n; i++) if (s.moving[i]) m += Math.min(segDt(s, i), MAX_WEIGHT_S);
  return m;
}

// ---------------------------------------------------------------------------
// Elevation grid & grades
// ---------------------------------------------------------------------------

export interface ElevationGrid {
  step: number;
  /** Smoothed elevation every `step` meters of distance (index k ↔ k·step m). */
  ele: Float64Array;
  /** Grade (fraction) at every grid point, clamped to ±45 %. */
  grade: Float64Array;
}

/** Resample elevation onto a regular distance grid, smooth it and derive grades (central differences). */
export function elevationGrid(
  dist: Float64Array,
  ele: Float64Array,
  step = GRID_STEP_M,
  halfWindow = 3,
): ElevationGrid | null {
  const n = dist.length;
  if (n < 2) return null;
  const total = dist[n - 1]!;
  if (!(total >= 5 * step)) return null;
  const m = Math.floor(total / step) + 1;
  const raw = new Float64Array(m);
  let j = 0;
  for (let k = 0; k < m; k++) {
    const d = k * step;
    while (j + 1 < n - 1 && dist[j + 1]! < d) j++;
    const d0 = dist[j]!;
    const d1 = dist[j + 1]!;
    const e0 = ele[j]!;
    const e1 = ele[j + 1]!;
    if (!isNum(e0) || !isNum(e1)) raw[k] = isNum(e0) ? e0 : e1;
    else raw[k] = d1 > d0 ? e0 + ((e1 - e0) * Math.min(1, Math.max(0, (d - d0) / (d1 - d0)))) : e0;
  }
  // hold values over gaps so smoothing / grades never see NaN
  let last = NaN;
  for (let k = 0; k < m; k++) {
    if (isNum(raw[k]!)) last = raw[k]!;
    else raw[k] = last;
  }
  let first = NaN;
  for (let k = m - 1; k >= 0; k--) {
    if (isNum(raw[k]!)) first = raw[k]!;
    else raw[k] = first;
  }
  if (!isNum(raw[0]!)) return null;
  const e = smooth(raw, halfWindow);
  const grade = new Float64Array(m);
  const h = 2;
  for (let k = 0; k < m; k++) {
    const a = Math.max(0, k - h);
    const b = Math.min(m - 1, k + h);
    const g = b > a ? (e[b]! - e[a]!) / ((b - a) * step) : 0;
    grade[k] = Math.max(-0.45, Math.min(0.45, g));
  }
  return { step, ele: e, grade };
}

function gridGradeAt(g: ElevationGrid, d: number): number {
  const k = Math.round(d / g.step);
  return g.grade[Math.max(0, Math.min(g.grade.length - 1, k))]!;
}

/** Grade-adjusted distance over moving segments → grade adjusted speed (m/s). */
export function gradeAdjustedSpeed(s: Series, grid: ElevationGrid, sport: string): number | null {
  if (!s.dist) return null;
  let flat = 0;
  let mov = 0;
  for (let i = 1; i < s.n; i++) {
    if (!s.moving[i]) continue;
    const dd = s.dist[i]! - s.dist[i - 1]!;
    mov += segDt(s, i);
    if (!(dd > 0)) continue;
    flat += dd * gradeCostFactor(gridGradeAt(grid, (s.dist[i]! + s.dist[i - 1]!) / 2), sport);
  }
  return mov > 0 ? flat / mov : null;
}

/** Per-sample grade adjusted speed (speed × cost factor of the local grade). */
export function gradeAdjustedSpeedSeries(s: Series, grid: ElevationGrid, sport: string): Float64Array | null {
  if (!s.speed || !s.dist) return null;
  const out = new Float64Array(s.n);
  for (let i = 0; i < s.n; i++) {
    const v = s.speed[i]!;
    out[i] = isNum(v) ? v * gradeCostFactor(gridGradeAt(grid, s.dist[i]!), sport) : NaN;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Decoupling & efficiency
// ---------------------------------------------------------------------------

export interface DecouplingOptions {
  /** Moving seconds at the start that are left out: heart rate still catches up with the output there. */
  warmupS?: number;
  /** Minimum moving time after the warm-up. */
  minMovingS?: number;
}

/**
 * The definition behind every stored decoupling value (activity page and Progress → Trends): the first 5 minutes of
 * moving time are warm-up, the rest must be at least 20 minutes (two halves of ≥ 10 minutes).
 */
export const DECOUPLING: Required<DecouplingOptions> = { warmupS: 300, minMovingS: 20 * 60 };
/** A larger drift is no physiology but a recording problem (a lift or a car ride with the workout running). */
export const DECOUPLING_MAX_ABS_PCT = 60;
/** Heart rate outside this range (bpm) is a sensor glitch. */
const HR_MIN = 40;
const HR_MAX = 230;

/**
 * Aerobic decoupling (Friel): the moving time after the warm-up is split into two equal halves; for each half the
 * time-weighted output (speed or power) and heart rate are averaged. Needs `minMovingS` of moving time after the
 * warm-up and heart rate covering ≥ 60 % of each half (measured in the capped weights, so sparse streams count
 * fully). Null when |decoupling| > DECOUPLING_MAX_ABS_PCT.
 * The analysis uses DECOUPLING; the defaults (no warm-up, 20 minutes) are the plain definition.
 */
export function aerobicDecoupling(
  s: Series,
  output: Float64Array | null,
  basis: ActivityDecoupling['basis'],
  o: DecouplingOptions = {},
): ActivityDecoupling | null {
  if (!output || !s.hr) return null;
  const warmupS = o.warmupS ?? 0;
  const minMovingS = o.minMovingS ?? 20 * 60;
  const body = movingSeconds(s) - warmupS;
  if (body < minMovingS) return null;
  const mid = warmupS + body / 2;
  const hr = s.hr.map((h) => (h >= HR_MIN && h <= HR_MAX ? h : NaN));
  const acc = [
    { o: 0, h: 0, w: 0, cap: 0 },
    { o: 0, h: 0, w: 0, cap: 0 },
  ];
  let cum = 0;
  for (let i = 1; i < s.n; i++) {
    if (!s.moving[i]) continue;
    const dt = segDt(s, i);
    const at = cum + dt / 2;
    cum += dt;
    if (at < warmupS) continue;
    const half = acc[at < mid ? 0 : 1]!;
    const w = Math.min(dt, MAX_WEIGHT_S);
    half.cap += w;
    const ov = segValue(output, i);
    const h = segValue(hr, i);
    if (!isNum(ov) || !isNum(h)) continue;
    half.o += ov * w;
    half.h += h * w;
    half.w += w;
  }
  const [a, b] = acc as [(typeof acc)[0], (typeof acc)[0]];
  if (!(a.w > 0) || !(b.w > 0) || a.w < 0.6 * a.cap || b.w < 0.6 * b.cap) return null;
  const first = { output: a.o / a.w, hr: a.h / a.w };
  const second = { output: b.o / b.w, hr: b.h / b.w };
  const r1 = first.output / first.hr;
  const r2 = second.output / second.hr;
  if (!(r1 > 0)) return null;
  const pct = ((r1 - r2) / r1) * 100;
  if (!(Math.abs(pct) <= DECOUPLING_MAX_ABS_PCT)) return null;
  return { basis, first, second, pct };
}

/** Efficiency factor: output per heartbeat (needs ≥ 10 min moving with heart rate on ≥ 50 % of it). */
export function efficiencyFactor(
  s: Series,
  output: number | null,
  basis: ActivityEfficiency['basis'],
): ActivityEfficiency | null {
  if (output === null || !(output > 0)) return null;
  if (movingSeconds(s) < 600) return null;
  const hr = movingMean(s, s.hr);
  if (hr.mean === null || hr.seconds < 0.5 * weightedMovingSeconds(s) || hr.mean <= 0) return null;
  const value = basis === 'power' ? output / hr.mean : (output * 60) / hr.mean;
  return { value, basis };
}

// ---------------------------------------------------------------------------
// Power
// ---------------------------------------------------------------------------

/** Power resampled to 1 s (NaN where there is no sample within 10 s on both sides). */
export function powerPerSecond(s: Series): Float64Array | null {
  if (!s.power || s.n < 2) return null;
  const T = Math.floor(s.t[s.n - 1]!);
  if (T < 1) return null;
  const out = new Float64Array(T + 1).fill(NaN);
  let j = 0;
  for (let sec = 0; sec <= T; sec++) {
    while (j + 1 < s.n && s.t[j + 1]! <= sec) j++;
    const t0 = s.t[j]!;
    const p0 = s.power[j]!;
    if (t0 === sec) {
      out[sec] = p0;
      continue;
    }
    if (j + 1 >= s.n || t0 > sec) continue;
    const t1 = s.t[j + 1]!;
    const p1 = s.power[j + 1]!;
    if (t1 - t0 > 10 || !isNum(p0) || !isNum(p1)) continue;
    out[sec] = p0 + ((p1 - p0) * (sec - t0)) / (t1 - t0);
  }
  return out;
}

/** Best average power over `window` seconds (≥ 90 % of the window must have data). */
export function peakPower(p: Float64Array, window: number): number | null {
  const n = p.length;
  if (n < window) return null;
  let sum = 0;
  let cnt = 0;
  let best = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = p[i]!;
    if (isNum(v)) {
      sum += v;
      cnt++;
    }
    if (i >= window) {
      const o = p[i - window]!;
      if (isNum(o)) {
        sum -= o;
        cnt--;
      }
    }
    if (i >= window - 1 && cnt >= 0.9 * window && sum / cnt > best) best = sum / cnt;
  }
  return best === -Infinity ? null : best;
}

/** Normalized power: 4th root of the mean of the 4th power of the 30 s rolling average. */
export function normalizedPower(p: Float64Array): number | null {
  const W = 30;
  if (p.length < 2 * W) return null;
  let sum = 0;
  let cnt = 0;
  let acc = 0;
  let k = 0;
  for (let i = 0; i < p.length; i++) {
    const v = p[i]!;
    if (isNum(v)) {
      sum += v;
      cnt++;
    }
    if (i >= W) {
      const o = p[i - W]!;
      if (isNum(o)) {
        sum -= o;
        cnt--;
      }
    }
    if (i >= W - 1 && cnt >= W / 2) {
      acc += (sum / cnt) ** 4;
      k++;
    }
  }
  return k >= W ? (acc / k) ** 0.25 : null;
}

/** Peak power durations of the activity page (a subset of PROGRESS_POWER_DURATIONS: the same bests as the curve). */
export const POWER_PEAK_WINDOWS = [5, 60, 300, 1200, 3600];

/**
 * Average, max and normalized power plus the peaks. The peaks are the power curve's best averages (power-math:
 * 1 Hz per track part, never across a break, unmeasured seconds count as 0 W), so the activity page and Progress →
 * Power show the same numbers.
 */
export function powerAnalysis(s: Series): ActivityPower | null {
  const p = powerPerSecond(s);
  if (!p || !s.power) return null;
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < p.length; i++) {
    const v = p[i]!;
    if (isNum(v)) {
      sum += v;
      cnt++;
    }
  }
  if (cnt < 60) return null;
  let maxW = 0;
  for (let i = 0; i < s.n; i++) {
    const v = s.power[i]!;
    if (isNum(v) && v > maxW) maxW = v;
  }
  const avgW = sum / cnt;
  const np = normalizedPower(p);
  const peaks = bestAverages(powerParts({ t: s.t, power: s.power, breaks: s.breaks }), POWER_PEAK_WINDOWS).map((b) => ({
    durationS: b.durationS,
    watts: b.watts,
  }));
  return {
    avgW,
    maxW,
    normalizedW: np,
    variabilityIndex: np !== null && avgW > 0 ? np / avgW : null,
    intensityFactor: null,
    tss: null,
    peaks,
  };
}

/** Rides with an FTP: intensity factor and training stress score. */
export function withFtp(p: ActivityPower, ftp: number | null, movingS: number): ActivityPower {
  if (!ftp || ftp <= 0 || p.normalizedW === null) return p;
  const intensityFactor = p.normalizedW / ftp;
  return {
    ...p,
    intensityFactor,
    tss: ((movingS * p.normalizedW * intensityFactor) / (ftp * 3600)) * 100,
  };
}

// ---------------------------------------------------------------------------
// Climbs
// ---------------------------------------------------------------------------

export interface ClimbOptions {
  minGainM: number;
  minGrade: number;
  minLengthM: number;
}

export const DEFAULT_CLIMB_OPTIONS: ClimbOptions = { minGainM: 15, minGrade: 0.03, minLengthM: 200 };

/**
 * Climbs on a smoothed elevation grid: start at a low point, extend while the profile does not drop more than a
 * tolerance (15 % of the gain so far, 5–20 m) below its running maximum, end at the maximum. Flat lead-ins and
 * plateaus are trimmed. Returns grid index ranges [start, end].
 */
export function detectClimbRanges(ele: Float64Array, step: number, o: ClimbOptions = DEFAULT_CLIMB_OPTIONS): [number, number][] {
  const m = ele.length;
  const out: [number, number][] = [];
  if (m < 3) return out;
  let low = 0;
  let high = 0;
  const emit = (a: number, b: number) => {
    const flat = Math.max(1, Math.round(50 / step));
    // trim a flat approach (< 1 % over 50 m) and a flat top
    while (a + flat < b && ele[a + flat]! - ele[a]! < 0.01 * flat * step) a++;
    while (b - flat > a && ele[b]! - ele[b - flat]! < 0.01 * flat * step) b--;
    const gain = ele[b]! - ele[a]!;
    const length = (b - a) * step;
    if (gain >= o.minGainM && length >= o.minLengthM && gain / length >= o.minGrade) out.push([a, b]);
  };
  for (let k = 1; k < m; k++) {
    const e = ele[k]!;
    if (e > ele[high]!) high = k;
    const gain = ele[high]! - ele[low]!;
    const drop = ele[high]! - e;
    const tol = Math.min(20, Math.max(5, 0.15 * gain));
    if (drop > tol) {
      if (gain >= o.minGainM) emit(low, high);
      low = k;
      high = k;
    } else if (e < ele[low]!) {
      low = k;
      high = k;
    }
  }
  if (ele[high]! - ele[low]! >= o.minGainM) emit(low, high);
  return out;
}

/** Time (s since start) at a distance, interpolated (dist is non-decreasing). */
export function timeAtDistance(s: Series, d: number): number {
  const dist = s.dist!;
  let lo = 0;
  let hi = s.n - 1;
  if (d <= dist[0]!) return s.t[0]!;
  if (d >= dist[hi]!) return s.t[hi]!;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid]! < d) lo = mid;
    else hi = mid;
  }
  const d0 = dist[lo]!;
  const d1 = dist[hi]!;
  return d1 > d0 ? s.t[lo]! + ((s.t[hi]! - s.t[lo]!) * (d - d0)) / (d1 - d0) : s.t[hi]!;
}

/** Time-weighted mean of a series between two times (all segments, not only moving). */
function meanBetween(s: Series, a: Float64Array | null, t0: number, t1: number): number | null {
  if (!a) return null;
  let sum = 0;
  let w = 0;
  for (let i = 1; i < s.n; i++) {
    const ta = Math.max(s.t[i - 1]!, t0);
    const tb = Math.min(s.t[i]!, t1);
    if (tb <= ta) continue;
    const v = segValue(a, i);
    if (!isNum(v)) continue;
    const dt = Math.min(tb - ta, 30);
    sum += v * dt;
    w += dt;
  }
  return w > 0 ? sum / w : null;
}

/** Grid indices [from, to] of one track part and the shift stitchElevation applied to its elevation. */
export interface GridPart {
  from: number;
  to: number;
  offset: number;
}

/**
 * The track parts on the elevation grid (the jump while paused has no distance, so a part ends at the last grid point
 * at or before the break and the next one starts after it), with the elevation shift of each part (stitched − real).
 */
export function gridParts(s: Series, grid: ElevationGrid, stitched: Float64Array | null): GridPart[] {
  const last = grid.ele.length - 1;
  if (!s.breaks.length || !s.dist) return [{ from: 0, to: last, offset: 0 }];
  const out: GridPart[] = [];
  let from = 0;
  for (const [a, b] of trackParts(s.n, s.breaks)) {
    let offset = 0;
    if (stitched && s.ele) {
      for (let i = a; i < b; i++) {
        if (isNum(s.ele[i]!) && isNum(stitched[i]!)) {
          offset = stitched[i]! - s.ele[i]!;
          break;
        }
      }
    }
    const end = s.dist[b - 1]!;
    const to = b < s.n && isNum(end) ? Math.min(last, Math.floor(end / grid.step)) : last;
    if (to >= from) out.push({ from, to, offset });
    from = Math.max(from, to + 1);
  }
  return out;
}

/**
 * Climbs on the elevation grid, detected within each track part (`parts`, default: one part) so a climb never spans
 * a ride travelled while paused. Start and end elevations are the real (unstitched) ones.
 */
export function climbsOf(
  s: Series,
  grid: ElevationGrid,
  o: ClimbOptions = DEFAULT_CLIMB_OPTIONS,
  parts: GridPart[] = [{ from: 0, to: grid.ele.length - 1, offset: 0 }],
): ActivityClimb[] {
  if (!s.dist) return [];
  const step = grid.step;
  const e = grid.ele;
  const w = Math.max(1, Math.round(100 / step));
  const ranges = parts.flatMap((p) =>
    p.to - p.from >= 2
      ? detectClimbRanges(e.subarray(p.from, p.to + 1), step, o).map(([a, b]) => [a + p.from, b + p.from, p.offset] as const)
      : [],
  );
  return ranges.map(([a, b, offset]) => {
    const startDistM = a * step;
    const endDistM = b * step;
    const lengthM = endDistM - startDistM;
    const gainM = e[b]! - e[a]!;
    let maxGrade = gainM / lengthM;
    if (b - a > w) for (let k = a; k + w <= b; k++) maxGrade = Math.max(maxGrade, (e[k + w]! - e[k]!) / (w * step));
    const startT = timeAtDistance(s, startDistM);
    const endT = timeAtDistance(s, endDistM);
    const durationS = Math.max(0, endT - startT);
    const avgGrade = gainM / lengthM;
    return {
      startT,
      endT,
      startDistM,
      endDistM,
      lengthM,
      gainM,
      startEleM: e[a]! - offset,
      endEleM: e[b]! - offset,
      avgGrade,
      maxGrade,
      durationS,
      vam: durationS > 0 ? gainM / (durationS / 3600) : 0,
      avgHr: meanBetween(s, s.hr, startT, endT),
      category: climbCategory(lengthM, avgGrade),
    };
  });
}

// ---------------------------------------------------------------------------
// Laps from workout events
// ---------------------------------------------------------------------------

const STROKE_STYLES: Record<string, string> = {
  '1': 'mixed',
  '2': 'freestyle',
  '3': 'backstroke',
  '4': 'breaststroke',
  '5': 'butterfly',
  '6': 'kickboard',
};

/** Linear interpolation of a (non-decreasing) series at time `x`. */
function valueAtTime(s: Series, a: Float64Array, x: number): number {
  if (x <= s.t[0]!) return a[0]!;
  if (x >= s.t[s.n - 1]!) return a[s.n - 1]!;
  let lo = 0;
  let hi = s.n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s.t[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const t0 = s.t[lo]!;
  const t1 = s.t[hi]!;
  return t1 > t0 ? a[lo]! + ((a[hi]! - a[lo]!) * (x - t0)) / (t1 - t0) : a[hi]!;
}

export interface RangeStats {
  distanceM: number | null;
  movingS: number;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  avgPower: number | null;
  elevGainM: number | null;
}

/**
 * Elevation gain of a lap: the definition of the activity's gain (derive/workouts.ts: elevationGainLoss(ele, 2, 5,
 * breaks)) – elevation smoothed within each part of the track, hysteresis of 2 m – so the laps of an activity add up to
 * its gain and barometer noise is no climbing.
 */
const LAP_GAIN_THRESHOLD_M = 2;
const LAP_GAIN_HALF_WINDOW = 5;

/** Elevation smoothed within each track part (one series, many laps: computed once). */
const partSmoothed = new WeakMap<Series, Float64Array>();

function smoothedElevation(s: Series): Float64Array | null {
  if (!s.ele) return null;
  let out = partSmoothed.get(s);
  if (!out) {
    out = new Float64Array(s.n);
    for (const [a, b] of trackParts(s.n, s.breaks)) out.set(smooth(s.ele.subarray(a, b), LAP_GAIN_HALF_WINDOW), a);
    partSmoothed.set(s, out);
  }
  return out;
}

/** Stats of the time range [t0, t1] (seconds since start). */
export function statsBetween(s: Series, t0: number, t1: number): RangeStats {
  let movingS = 0;
  let maxHr: number | null = null;
  let gain: number | null = null;
  for (let i = 1; i < s.n; i++) {
    const ta = Math.max(s.t[i - 1]!, t0);
    const tb = Math.min(s.t[i]!, t1);
    if (tb <= ta) continue;
    if (s.moving[i]) movingS += Math.min(tb - ta, MAX_SEGMENT_S);
  }
  if (s.hr) {
    for (let i = 0; i < s.n; i++) {
      const ti = s.t[i]!;
      if (ti < t0 || ti > t1) continue;
      const h = s.hr[i]!;
      if (isNum(h) && (maxHr === null || h > maxHr)) maxHr = h;
    }
  }
  const ele = smoothedElevation(s);
  if (ele) {
    gain = 0;
    // each track part on its own: the height difference between two parts was travelled while paused
    for (const [a, b] of trackParts(s.n, s.breaks)) {
      let ref = NaN;
      for (let i = a; i < b; i++) {
        const ti = s.t[i]!;
        if (ti < t0 || ti > t1) continue;
        const e = ele[i]!;
        if (!isNum(e)) continue;
        if (!isNum(ref)) ref = e;
        else if (e - ref >= LAP_GAIN_THRESHOLD_M) {
          gain += e - ref;
          ref = e;
        } else if (ref - e >= LAP_GAIN_THRESHOLD_M) ref = e;
      }
    }
  }
  return {
    distanceM: s.dist ? Math.max(0, valueAtTime(s, s.dist, t1) - valueAtTime(s, s.dist, t0)) : null,
    movingS,
    avgHr: meanBetween(s, s.hr, t0, t1),
    maxHr,
    avgCadence: meanBetween(s, s.cadence, t0, t1),
    avgPower: meanBetween(s, s.power, t0, t1),
    elevGainM: gain,
  };
}

/** Laps ('lap') or segments ('segment') from workout events with stats from the streams. */
export function lapsFromEvents(
  s: Series | null,
  events: AnalysisEvent[],
  kind: ActivityLap['kind'],
  o: { sport: string; startTs: number; endTs: number; lapLengthM: number | null },
  limit = 1000,
): ActivityLap[] {
  const evs = events.filter((e) => e.type === kind).sort((a, b) => a.ts - b.ts);
  if (!evs.length) return [];
  const laps = events.filter((e) => e.type === 'lap');
  const swim = o.sport === 'swim';
  const out: ActivityLap[] = [];
  for (let k = 0; k < evs.length && out.length < limit; k++) {
    const e = evs[k]!;
    const startT = Math.max(0, e.ts - o.startTs);
    const nextTs = evs[k + 1]?.ts ?? o.endTs;
    const durationS = e.durationS !== null && e.durationS > 0 ? e.durationS : Math.max(0, nextTs - e.ts);
    if (durationS <= 0) continue;
    const endT = startT + durationS;
    const st = s && s.n >= 2 ? statsBetween(s, startT, endT) : null;
    let lengths: number | null = null;
    let distanceM = st?.distanceM ?? null;
    if (swim && o.lapLengthM) {
      lengths =
        kind === 'lap'
          ? 1
          : laps.filter((l) => l.ts >= e.ts - 0.5 && l.ts < e.ts + durationS - 0.5).length || null;
      if (lengths) distanceM = lengths * o.lapLengthM;
    }
    const movingS = st && st.movingS > 0 ? Math.min(st.movingS, durationS) : durationS;
    const timeBase = swim ? durationS : movingS;
    const style = e.meta?.HKSwimmingStrokeStyle;
    out.push({
      idx: out.length,
      kind,
      startT,
      endT,
      durationS,
      distanceM,
      movingS,
      avgSpeed: distanceM !== null && distanceM > 0 && timeBase > 0 ? distanceM / timeBase : null,
      avgHr: st?.avgHr ?? null,
      maxHr: st?.maxHr ?? null,
      avgCadence: st?.avgCadence ?? null,
      avgPower: st?.avgPower ?? null,
      elevGainM: st?.elevGainM ?? null,
      strokeStyle: style ? (STROKE_STYLES[style] ?? null) : null,
      lengths,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Everything together
// ---------------------------------------------------------------------------

const DECOUPLING_EXCLUDED = new Set(['swim', 'multisport', 'golf', 'transition']);

export function analyzeActivity(inp: AnalysisInput): AnalysisResult {
  const { sport } = inp;
  const elapsed = Math.max(0, inp.endTs - inp.startTs);
  const s = inp.streams.t.length >= 2 ? toSeries(inp.streams) : null;
  const lapOpts = { sport, startTs: inp.startTs, endTs: inp.endTs, lapLengthM: inp.lapLengthM };
  const laps = lapsFromEvents(s, inp.events, 'lap', lapOpts);
  const segments = lapsFromEvents(s, inp.events, 'segment', lapOpts);
  if (!s) {
    return {
      hasStreams: false,
      avgSpeed: null,
      gapSpeed: null,
      efficiency: null,
      paceEfficiency: null,
      decoupling: null,
      climbs: [],
      laps,
      segments,
      power: null,
      stoppedS: 0,
    };
  }
  const info = sportInfo(sport);
  const movingS = movingSeconds(s);
  const totalDist = s.dist ? s.dist[s.n - 1]! : null;
  const avgSpeed = totalDist !== null && movingS > 0 ? totalDist / movingS : null;
  // the height difference between track parts (travelled while paused) is no climb
  const stitched = s.ele && s.breaks.length ? stitchElevation(s.ele, s.breaks) : null;
  const grid = s.dist && s.ele ? elevationGrid(s.dist, stitched ?? s.ele) : null;
  const footSport = (GAP_SPORTS as readonly string[]).includes(sport);
  const gapSpeed = footSport && grid ? gradeAdjustedSpeed(s, grid, sport) : null;
  const power = powerAnalysis(s);
  const cycling = info.group === 'cycle';

  // One definition for the activity page and Progress → Trends (which reads the stored values): Pw:HR for rides
  // with power, else (grade adjusted) Pa:HR; DECOUPLING leaves out the warm-up.
  const paced = info.distance && !DECOUPLING_EXCLUDED.has(sport) && !!s.speed && !!s.dist;
  const paceEfficiency = paced ? efficiencyFactor(s, gapSpeed ?? avgSpeed, gapSpeed !== null ? 'gap' : 'speed') : null;
  let decoupling: ActivityDecoupling | null = null;
  let efficiency: ActivityEfficiency | null = null;
  if (cycling && power) {
    decoupling = aerobicDecoupling(s, s.power, 'power', DECOUPLING);
    efficiency = efficiencyFactor(s, power.normalizedW ?? power.avgW, 'power');
  }
  if (paced) {
    const output = footSport && grid ? gradeAdjustedSpeedSeries(s, grid, sport) : s.speed;
    decoupling ??= aerobicDecoupling(s, output, 'pace', DECOUPLING);
    efficiency ??= paceEfficiency;
  }

  return {
    hasStreams: true,
    avgSpeed,
    gapSpeed,
    efficiency,
    paceEfficiency,
    decoupling,
    climbs: grid && totalDist !== null && totalDist >= 500 ? climbsOf(s, grid, DEFAULT_CLIMB_OPTIONS, gridParts(s, grid, stitched)) : [],
    laps,
    segments,
    power,
    stoppedS: Math.max(0, elapsed - movingS),
  };
}
