/**
 * Two activities side by side (pure, no DOM): both aligned on the distance from their start (on the clock when one of
 * them has no distance), the time gap between them, per-distance series for the charts, the clock of a synchronized
 * replay and the rows of the summary table.
 *
 * Conventions as in streams.ts: sample i closes the segment (i−1 → i) and moving[i] says whether that segment is moving
 * time; NaN = missing. Track breaks (Prepared.breaks: a jump travelled while paused) are never interpolated across — a
 * position is never placed on the jump and chart lines get a gap there.
 */
import type { WorkoutDetail } from '@cadence/shared';
import { fracIndex, haversine, valueAt, type Prepared } from './streams';

export type TimeBase = 'moving' | 'elapsed';

/** Longest single segment counted as moving time (the server's movingTime caps the same way). */
const MAX_SEGMENT_S = 600;

/** The shortest common distance (m) worth aligning on. */
export const MIN_COMPARE_M = 100;

/** The shortest common duration (s) worth aligning on the clock. */
export const MIN_COMPARE_S = 60;

/** Seconds on the chosen clock at every sample: the elapsed time since the start, or the moving time so far. */
export function clockOf(P: Pick<Prepared, 'n' | 't' | 'moving'>, base: TimeBase): Float64Array {
  if (base === 'elapsed') return P.t;
  const out = new Float64Array(P.n);
  for (let i = 1; i < P.n; i++) {
    const dt = Math.min(Math.max(0, P.t[i]! - P.t[i - 1]!), MAX_SEGMENT_S);
    out[i] = out[i - 1]! + (P.moving[i] ? dt : 0);
  }
  return out;
}

/** Whether a fractional index lies on the segment that jumps to a new track part (i → i+1 with i+1 a break). */
function onBreak(breaks: number[], fi: number): number | null {
  const i = Math.floor(fi);
  return fi > i && breaks.includes(i + 1) ? i : null;
}

/** Value at a fractional index, never interpolated across a track break (the last value before the jump). */
export function valueAtNoBreak(arr: Float64Array | null, fi: number, breaks: number[]): number {
  if (!arr) return NaN;
  const i = onBreak(breaks, fi);
  return i === null ? valueAt(arr, fi) : arr[i]!;
}

/** [lon, lat] at a fractional index; on the jump between two track parts it stays at the last fix before the jump. */
export function positionAt(P: Pick<Prepared, 'lat' | 'lon' | 'breaks'>, fi: number): [number, number] | null {
  if (!P.lat || !P.lon) return null;
  const i = onBreak(P.breaks, fi);
  if (i !== null) return [P.lon[i]!, P.lat[i]!];
  return [valueAt(P.lon, fi), valueAt(P.lat, fi)];
}

export interface Alignment {
  /** 'distance': both on the distance from their start; 'time': on the clock (one of them has no distance). */
  mode: 'distance' | 'time';
  base: TimeBase;
  /** Grid from 0 to `span`: meters (distance mode) or clock seconds (time mode). */
  x: Float64Array;
  /** The common distance (m) or duration (s): the shorter of both. */
  span: number;
  /** Clock (s) at every sample of A and B (see clockOf). */
  clockA: Float64Array;
  clockB: Float64Array;
  /** Fractional stream index of A and B at every grid point. */
  iA: Float64Array;
  iB: Float64Array;
  /** Distance mode: clock time (s) when A / B reached each grid distance (null in time mode). */
  tA: Float64Array | null;
  tB: Float64Array | null;
  /** tB − tA (s): positive = A reached the distance earlier, i.e. A was ahead there. Null in time mode. */
  gap: Float64Array | null;
  /** Grid indices at which a new part of A's / B's track starts (chart lines get a gap before them). */
  breaksA: number[];
  breaksB: number[];
}

export const canAlignByDistance = (A: Prepared, B: Prepared): boolean =>
  !!A.dist && !!B.dist && Math.min(A.totalDist, B.totalDist) >= MIN_COMPARE_M;

/** The first grid index at or beyond the key (distance / clock) of every break: the first point of the new part. */
function gridBreaks(key: Float64Array, breaks: number[], step: number, n: number): number[] {
  const out = new Set<number>();
  for (const b of breaks) {
    const k = Math.ceil(key[b]! / step - 1e-9);
    if (k > 0 && k < n) out.add(k);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Align A and B on the distance from their start (both need ≥ MIN_COMPARE_M), else on the clock. The grid covers the
 * common span only (the shorter activity) with at most `maxPoints` points (5 m resp. 1 s apart when short).
 */
export function align(A: Prepared, B: Prepared, base: TimeBase, maxPoints = 1000): Alignment | null {
  const distance = canAlignByDistance(A, B);
  const clockA = clockOf(A, base);
  const clockB = clockOf(B, base);
  const keyA = distance ? A.dist! : clockA;
  const keyB = distance ? B.dist! : clockB;
  const span = Math.min(keyA[A.n - 1]!, keyB[B.n - 1]!);
  if (!(span >= (distance ? MIN_COMPARE_M : MIN_COMPARE_S))) return null;
  const n = Math.max(2, Math.min(maxPoints, Math.ceil(span / (distance ? 5 : 1)) + 1));
  const step = span / (n - 1);
  const x = new Float64Array(n);
  const iA = new Float64Array(n);
  const iB = new Float64Array(n);
  const tA = distance ? new Float64Array(n) : null;
  const tB = distance ? new Float64Array(n) : null;
  const gap = distance ? new Float64Array(n) : null;
  for (let k = 0; k < n; k++) {
    const v = k === n - 1 ? span : k * step;
    x[k] = v;
    iA[k] = fracIndex(keyA, v);
    iB[k] = fracIndex(keyB, v);
    if (tA && tB && gap) {
      tA[k] = valueAt(clockA, iA[k]!);
      tB[k] = valueAt(clockB, iB[k]!);
      gap[k] = tB[k]! - tA[k]!;
    }
  }
  return {
    mode: distance ? 'distance' : 'time',
    base,
    x,
    span,
    clockA,
    clockB,
    iA,
    iB,
    tA,
    tB,
    gap,
    breaksA: gridBreaks(keyA, A.breaks, step, n),
    breaksB: gridBreaks(keyB, B.breaks, step, n),
  };
}

export interface SideSeries {
  /** Mean speed (m/s) while moving per grid bin. */
  speed: Float64Array | null;
  hr: Float64Array | null;
  cadence: Float64Array | null;
  power: Float64Array | null;
  /** Elevation (m) interpolated at the grid points. */
  ele: Float64Array | null;
}

/**
 * Mean of `values` per grid bin (bin k is centred on x[k]), weighted by each sample's duration (≤ 30 s); with
 * `movingOnly` stopped samples are left out. A bin without samples takes the value interpolated at x[k] (NaN while
 * stopped when `movingOnly`), never across a track break.
 */
function binned(
  P: Prepared,
  key: Float64Array,
  idx: Float64Array,
  x: Float64Array,
  values: Float64Array | null,
  movingOnly: boolean,
): Float64Array | null {
  if (!values) return null;
  const n = x.length;
  const step = n > 1 ? x[1]! - x[0]! : 1;
  const sum = new Float64Array(n);
  const weight = new Float64Array(n);
  const limit = x[n - 1]! + step / 2;
  for (let i = 0; i < P.n; i++) {
    const kv = key[i]!;
    if (kv >= limit) break;
    if (movingOnly && !P.moving[i]) continue;
    const v = values[i]!;
    if (v !== v) continue;
    const k = Math.round(kv / step);
    if (k < 0 || k >= n) continue;
    const w = i ? Math.min(30, Math.max(0.1, P.t[i]! - P.t[i - 1]!)) : 1;
    sum[k]! += v * w;
    weight[k]! += w;
  }
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    if (weight[k]! > 0) out[k] = sum[k]! / weight[k]!;
    else {
      const fi = idx[k]!;
      out[k] = movingOnly && !P.moving[Math.min(P.n - 1, Math.ceil(fi))] ? NaN : valueAtNoBreak(values, fi, P.breaks);
    }
  }
  return out;
}

/** Speed, heart rate, cadence, power and elevation of one side on the alignment grid. */
export function sideSeries(P: Prepared, al: Alignment, side: 'a' | 'b'): SideSeries {
  const idx = side === 'a' ? al.iA : al.iB;
  const key = al.mode === 'distance' ? P.dist! : side === 'a' ? al.clockA : al.clockB;
  const ele = P.ele ? Float64Array.from(idx, (fi) => valueAtNoBreak(P.ele, fi, P.breaks)) : null;
  return {
    speed: P.dist ? binned(P, key, idx, al.x, P.speed, true) : null,
    hr: binned(P, key, idx, al.x, P.hr, false),
    cadence: binned(P, key, idx, al.x, P.cadence, true),
    power: binned(P, key, idx, al.x, P.power, false),
    ele,
  };
}

/**
 * Centered moving average over ±`half` grid points (NaN-aware; NaN stays NaN), restarted at every break so a new track
 * part never mixes with the previous one.
 */
export function smoothGrid(ys: Float64Array, half: number, breaks: number[] = []): Float64Array {
  const n = ys.length;
  const out = new Float64Array(n);
  const cuts = [0, ...breaks.filter((k) => k > 0 && k < n).sort((a, b) => a - b), n];
  for (let c = 0; c + 1 < cuts.length; c++) {
    const a = cuts[c]!;
    const b = cuts[c + 1]!;
    let sum = 0;
    let cnt = 0;
    let lo = a;
    let hi = a - 1;
    for (let k = a; k < b; k++) {
      const to = Math.min(b - 1, k + half);
      const from = Math.max(a, k - half);
      while (hi < to) {
        hi++;
        if (ys[hi] === ys[hi]) (sum += ys[hi]!), cnt++;
      }
      while (lo < from) {
        if (ys[lo] === ys[lo]) (sum -= ys[lo]!), cnt--;
        lo++;
      }
      out[k] = ys[k] === ys[k] && cnt ? sum / cnt : NaN;
    }
  }
  return out;
}

/** Value of a grid series at x (linear between grid points). */
export function gridValue(al: Pick<Alignment, 'x'>, series: Float64Array, x: number): number {
  return valueAt(series, fracIndex(al.x, x));
}

/**
 * Median distance (m) between A's and B's position at the same distance from the start, from `samples` points along the
 * common distance; null without GPS in both. Large values mean the routes differ.
 */
export function routeSeparation(A: Prepared, B: Prepared, al: Alignment, samples = 48): number | null {
  if (al.mode !== 'distance' || !A.lat || !B.lat) return null;
  const ds: number[] = [];
  for (let s = 0; s < samples; s++) {
    const k = Math.round(((s + 0.5) / samples) * (al.x.length - 1));
    const a = positionAt(A, al.iA[k]!);
    const b = positionAt(B, al.iB[k]!);
    if (a && b) ds.push(haversine(a[1], a[0], b[1], b[0]));
  }
  if (!ds.length) return null;
  ds.sort((x, y) => x - y);
  const m = ds.length >> 1;
  return ds.length % 2 ? ds[m]! : (ds[m - 1]! + ds[m]!) / 2;
}

// ---------------------------------------------------------------------------
// Synchronized replay
// ---------------------------------------------------------------------------

/**
 * Intervals in which both were stopped (on a common elapsed clock), at least `minS` long. After its last sample an
 * activity counts as stopped, so the replay also skips the other one's pauses once the first has finished.
 */
export function commonPauses(
  a: [number, number][],
  endA: number,
  b: [number, number][],
  endB: number,
  minS = 10,
): [number, number][] {
  const xa = [...a, [endA, Infinity] as [number, number]];
  const xb = [...b, [endB, Infinity] as [number, number]];
  const end = Math.max(endA, endB);
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < xa.length && j < xb.length) {
    const s = Math.max(xa[i]![0], xb[j]![0]);
    const e = Math.min(xa[i]![1], xb[j]![1], end);
    if (e - s >= minS) out.push([s, e]);
    if (xa[i]![1] < xb[j]![1]) i++;
    else j++;
  }
  return out;
}

export interface ReplayClock {
  /** Length of the replay (s): the later finish on the chosen clock. */
  duration: number;
  /** Intervals the replay skips (elapsed clock: both stopped). */
  pauses: [number, number][];
}

export function replayClock(A: Prepared, B: Prepared, al: Alignment): ReplayClock {
  const endA = al.clockA[A.n - 1]!;
  const endB = al.clockB[B.n - 1]!;
  return {
    duration: Math.max(endA, endB),
    pauses: al.base === 'elapsed' ? commonPauses(A.pauses, endA, B.pauses, endB) : [],
  };
}

export interface ReplayPosition {
  /** Fractional stream indices of A and B at the replay time. */
  iA: number;
  iB: number;
  /** Distance (m) covered so far; null without distance. */
  dA: number | null;
  dB: number | null;
  /** dA − dB (m): positive = A is ahead; null unless both have distance. */
  lead: number | null;
  /**
   * Time gap (s) at the distance of the one behind: how long ago the leader passed that point (positive = A ahead).
   * Null outside distance alignment.
   */
  gap: number | null;
}

export function replayAt(A: Prepared, B: Prepared, al: Alignment, time: number): ReplayPosition {
  const iA = fracIndex(al.clockA, time);
  const iB = fracIndex(al.clockB, time);
  const dA = A.dist ? valueAt(A.dist, iA) : null;
  const dB = B.dist ? valueAt(B.dist, iB) : null;
  const lead = dA !== null && dB !== null ? dA - dB : null;
  let gap: number | null = null;
  if (al.gap && dA !== null && dB !== null) {
    const behind = Math.min(dA, dB, al.span);
    gap = gridValue(al, al.gap, behind);
    // both still together at the start: no gap yet
    if (behind <= 0) gap = 0;
  }
  return { iA, iB, dA, dB, lead, gap };
}

// ---------------------------------------------------------------------------
// Summary table
// ---------------------------------------------------------------------------

export type SummaryKey =
  | 'distance'
  | 'commonTime'
  | 'moving'
  | 'elapsed'
  | 'speed'
  | 'avgHr'
  | 'maxHr'
  | 'elevation'
  | 'power'
  | 'cadence';

export interface SummaryRow {
  key: SummaryKey;
  a: number | null;
  b: number | null;
  /** a − b; null unless both are known. */
  diff: number | null;
  /** Which direction is better for A ('lower' time, 'higher' speed); null = neither (heart rate, elevation…). */
  better: 'lower' | 'higher' | null;
}

export type SummaryInput = Pick<
  WorkoutDetail,
  'distanceM' | 'movingS' | 'durationS' | 'elapsedS' | 'avgSpeed' | 'avgHr' | 'maxHr' | 'elevationGainM' | 'avgPower' | 'avgCadence'
>;

const known = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v) && v > 0;

/**
 * Rows of the side-by-side summary: every metric at least one of both has. `common` adds the time over the common
 * distance (when the distances differ, the plain moving times are not comparable).
 */
export function summaryRows(a: SummaryInput, b: SummaryInput, common?: { a: number; b: number } | null): SummaryRow[] {
  const rows: [SummaryKey, number | null, number | null, SummaryRow['better']][] = [
    ['distance', a.distanceM, b.distanceM, null],
    ...(common ? [['commonTime', common.a, common.b, 'lower'] as [SummaryKey, number, number, 'lower']] : []),
    ['moving', a.movingS ?? a.durationS, b.movingS ?? b.durationS, 'lower'],
    ['elapsed', a.elapsedS, b.elapsedS, 'lower'],
    ['speed', a.avgSpeed, b.avgSpeed, 'higher'],
    ['avgHr', a.avgHr, b.avgHr, null],
    ['maxHr', a.maxHr, b.maxHr, null],
    ['elevation', a.elevationGainM, b.elevationGainM, null],
    ['power', a.avgPower, b.avgPower, 'higher'],
    ['cadence', a.avgCadence, b.avgCadence, null],
  ];
  return rows
    .filter(([, x, y]) => known(x) || known(y))
    .map(([key, x, y, better]) => ({
      key,
      a: known(x) ? x : null,
      b: known(y) ? y : null,
      diff: known(x) && known(y) ? x - y : null,
      better,
    }));
}
