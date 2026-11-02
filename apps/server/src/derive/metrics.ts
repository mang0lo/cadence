import type { EffortDefinition } from '@cadence/shared';
import { smooth } from './streams';

/**
 * Pure metric computations over full-resolution stream arrays (t in seconds since start, NaN = missing).
 */

export function movingTime(t: ArrayLike<number>, moving: ArrayLike<number>): number {
  let s = 0;
  for (let i = 1; i < t.length; i++) if (moving[i]) s += Math.min(t[i]! - t[i - 1]!, 600);
  return s;
}

/** Elevation gain/loss with smoothing and hysteresis (ignores GPS/barometer noise below `thresholdM`). */
export function elevationGainLoss(
  ele: Float64Array,
  thresholdM = 2,
  halfWindow = 5,
): { gain: number; loss: number } {
  if (ele.length < 2) return { gain: 0, loss: 0 };
  const s = smooth(ele, halfWindow);
  let ref = NaN;
  let gain = 0;
  let loss = 0;
  for (let i = 0; i < s.length; i++) {
    const e = s[i]!;
    if (e !== e) continue;
    if (ref !== ref) {
      ref = e;
      continue;
    }
    if (e - ref >= thresholdM) {
      gain += e - ref;
      ref = e;
    } else if (ref - e >= thresholdM) {
      loss += ref - e;
      ref = e;
    }
  }
  return { gain, loss };
}

/** Max of the smoothed speed while moving, capped at a plausible maximum (robust against single spikes). */
export function robustMaxSpeed(speed: Float64Array, moving: Uint8Array, cap: number): number | null {
  let m = 0;
  for (let i = 0; i < speed.length; i++) {
    const v = speed[i]!;
    if (moving[i] && v === v && v > m && v <= cap) m = v;
  }
  return m > 0 ? m : null;
}

export interface SplitRow {
  idx: number;
  distanceM: number;
  elapsedS: number;
  movingS: number;
  elevDiffM: number | null;
  avgHr: number | null;
  avgSpeed: number;
}

function valueAt(a: Float64Array | null, i0: number, i1: number, frac: number): number {
  if (!a) return NaN;
  const x = a[i0]!;
  const y = a[i1]!;
  if (x !== x) return y;
  if (y !== y) return x;
  return x + (y - x) * frac;
}

/** Splits per `unitM` (1000 m or 1609.344 m); a trailing partial split ≥ 10 m is included. */
export function computeSplits(
  t: Float64Array,
  dist: Float64Array,
  unitM: number,
  opts: { ele?: Float64Array | null; hr?: Float64Array | null; moving?: Uint8Array | null } = {},
): SplitRow[] {
  const n = t.length;
  const out: SplitRow[] = [];
  if (n < 2) return out;
  const ele = opts.ele ?? null;
  const hr = opts.hr ?? null;
  const moving = opts.moving ?? null;
  let k = 1;
  let splitStartT = t[0]!;
  let splitStartEle = valueAt(ele, 0, 0, 0);
  let mov = 0;
  let hrSum = 0;
  let hrDt = 0;
  const add = (i: number, dt: number) => {
    if (dt <= 0) return;
    if (!moving || moving[i]) mov += Math.min(dt, 600);
    if (hr) {
      const h = valueAt(hr, i - 1, i, 0.5);
      if (h === h) {
        hrSum += h * dt;
        hrDt += dt;
      }
    }
  };
  const emit = (endT: number, endEle: number, distanceM: number) => {
    const elapsed = endT - splitStartT;
    out.push({
      idx: out.length,
      distanceM,
      elapsedS: elapsed,
      movingS: mov,
      elevDiffM: endEle === endEle && splitStartEle === splitStartEle ? endEle - splitStartEle : null,
      avgHr: hrDt > 0 ? hrSum / hrDt : null,
      avgSpeed: mov > 0 ? distanceM / mov : elapsed > 0 ? distanceM / elapsed : 0,
    });
    mov = 0;
    hrSum = 0;
    hrDt = 0;
    splitStartT = endT;
    splitStartEle = endEle;
  };
  for (let i = 1; i < n; i++) {
    const d0 = dist[i - 1]!;
    const d1 = dist[i]!;
    const t0 = t[i - 1]!;
    const t1 = t[i]!;
    let segStart = t0;
    while (d1 >= k * unitM && d1 > d0) {
      const frac = (k * unitM - d0) / (d1 - d0);
      const tb = t0 + (t1 - t0) * frac;
      add(i, tb - segStart);
      emit(tb, valueAt(ele, i - 1, i, frac), unitM);
      segStart = tb;
      k++;
    }
    add(i, t1 - segStart);
  }
  const rest = dist[n - 1]! - (k - 1) * unitM;
  if (rest >= 10) emit(t[n - 1]!, valueAt(ele, n - 1, n - 1, 0), rest);
  return out;
}

/** Upper speed bound (m/s) for a best effort of `distanceM` – faster windows are GPS artefacts. */
export function effortSpeedLimit(sport: string, distanceM: number): number {
  switch (sport) {
    case 'run':
      if (distanceM <= 500) return 10.5;
      if (distanceM <= 1000) return 8.2;
      if (distanceM <= 5000) return 7.2;
      if (distanceM <= 21100) return 6.5;
      return 6.1;
    case 'walk':
      return 4.5;
    case 'hike':
      return 4.5;
    case 'ride':
      return distanceM <= 10000 ? 22 : 18;
    case 'swim':
      return 2.4;
    case 'row':
      return 7;
    case 'nordic_ski':
      return 10;
    default:
      return 30;
  }
}

export interface EffortResult {
  key: string;
  distanceM: number;
  elapsedS: number;
  startOffsetS: number;
}

/**
 * Fastest time over each distance: O(n) two-pointer sliding window over cumulative distance with linear
 * interpolation of the window start. Windows faster than the sport's plausibility limit are skipped.
 */
export function bestEfforts(
  t: Float64Array,
  dist: Float64Array,
  defs: EffortDefinition[],
  sport: string,
): EffortResult[] {
  const n = t.length;
  const out: EffortResult[] = [];
  if (n < 2) return out;
  const total = dist[n - 1]!;
  for (const def of defs) {
    const D = def.distanceM;
    if (D > total) continue;
    const minElapsed = D / effortSpeedLimit(sport, D);
    let best = Infinity;
    let bestStart = 0;
    let i = 0;
    for (let j = 1; j < n; j++) {
      const dj = dist[j]!;
      if (dj < D) continue;
      while (i + 1 < j && dj - dist[i + 1]! >= D) i++;
      const target = dj - D;
      const seg = dist[i + 1]! - dist[i]!;
      const ts =
        seg > 0 ? t[i]! + ((t[i + 1]! - t[i]!) * Math.min(Math.max(target - dist[i]!, 0), seg)) / seg : t[i]!;
      const el = t[j]! - ts;
      if (el >= minElapsed && el < best) {
        best = el;
        bestStart = ts;
      }
    }
    if (best < Infinity) out.push({ key: def.key, distanceM: D, elapsedS: best, startOffsetS: bestStart });
  }
  return out;
}

/** Seconds spent at each integer bpm (0..255). The basis for zones and TRIMP under any HR settings. */
export function hrHistogram(t: Float64Array, hr: Float64Array): Float32Array | null {
  const hist = new Float32Array(256);
  let any = false;
  for (let i = 1; i < t.length; i++) {
    const dt = t[i]! - t[i - 1]!;
    if (dt <= 0 || dt > 60) continue;
    const a = hr[i - 1]!;
    const b = hr[i]!;
    const h = a === a ? (b === b ? (a + b) / 2 : a) : b;
    if (h !== h || h < 25 || h > 250) continue;
    hist[Math.round(h)]! += dt;
    any = true;
  }
  return any ? hist : null;
}

/** Banister TRIMP: Σ minutes · HRr · 0.64 · e^(k · HRr), k = 1.92 (male) / 1.67 (female). */
export function trimpFromHistogram(
  hist: ArrayLike<number>,
  restingHr: number,
  maxHr: number,
  sex: string | null,
): number {
  const k = sex === 'female' ? 1.67 : sex === 'male' ? 1.92 : 1.795;
  const range = Math.max(1, maxHr - restingHr);
  let trimp = 0;
  for (let b = 0; b < hist.length; b++) {
    const s = hist[b]!;
    if (!s) continue;
    const hrr = Math.min(1.1, Math.max(0, (b - restingHr) / range));
    trimp += (s / 60) * hrr * 0.64 * Math.exp(k * hrr);
  }
  return trimp;
}

/** TRIMP from an average heart rate over a duration (fallback without an HR stream). */
export function trimpFromAverage(
  avgHr: number,
  durationS: number,
  restingHr: number,
  maxHr: number,
  sex: string | null,
): number {
  const hist = new Float32Array(256);
  hist[Math.max(0, Math.min(255, Math.round(avgHr)))] = durationS;
  return trimpFromHistogram(hist, restingHr, maxHr, sex);
}

/** Seconds in Z1..Z5 given upper bounds of Z1..Z4. */
export function zonesFromHistogram(hist: ArrayLike<number>, zoneBounds: number[]): number[] {
  const z = [0, 0, 0, 0, 0];
  for (let b = 0; b < hist.length; b++) {
    const s = hist[b]!;
    if (!s) continue;
    let idx = zoneBounds.length;
    for (let i = 0; i < zoneBounds.length; i++)
      if (b < zoneBounds[i]!) {
        idx = i;
        break;
      }
    z[idx]! += s;
  }
  return z.map((x) => Math.round(x));
}

/** Relative effort per minute without heart rate data (rough per-sport estimates). */
export function effortPerMinute(sport: string): number {
  switch (sport) {
    case 'run':
    case 'track_and_field':
      return 1.5;
    case 'hiit':
    case 'cross_training':
    case 'jump_rope':
    case 'boxing':
    case 'kickboxing':
    case 'mixed_cardio':
      return 1.4;
    case 'ride':
    case 'row':
    case 'swim':
    case 'nordic_ski':
    case 'elliptical':
    case 'stair_climbing':
    case 'soccer':
    case 'basketball':
    case 'squash':
      return 1.2;
    case 'hike':
    case 'functional_strength':
    case 'strength':
    case 'core':
    case 'climb':
    case 'tennis':
    case 'alpine_ski':
    case 'snowboard':
      return 0.9;
    case 'walk':
    case 'dance':
    case 'golf':
      return 0.5;
    case 'yoga':
    case 'pilates':
    case 'flexibility':
    case 'cooldown':
    case 'mind_body':
    case 'tai_chi':
    case 'recovery':
      return 0.3;
    default:
      return 0.7;
  }
}
