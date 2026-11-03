/**
 * Client-side stream math for the activity page: typed arrays, interpolation at fractional indices, grades,
 * headings, pauses, decimation for charts, statistics of a selected range and histograms.
 *
 * Convention (same as the server): t = seconds since start; sample i closes the segment (i−1 → i) and
 * moving[i] says whether that segment is moving time. NaN = missing value.
 */
import { GAP_SPORTS, gradeCostFactor, stitchElevation, type WorkoutStreams } from '@cadence/shared';

const RAD = Math.PI / 180;
const EARTH_R = 6371008.8;
const isNum = (x: number) => x === x;

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing in degrees (0 = north, clockwise). */
export function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * RAD;
  const p2 = lat2 * RAD;
  const dl = (lon2 - lon1) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Interpolate angles (degrees) the short way round. */
export function lerpAngle(a: number, b: number, f: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return (a + d * f + 360) % 360;
}

export interface Prepared {
  n: number;
  t: Float64Array;
  dist: Float64Array | null;
  lat: Float64Array | null;
  lon: Float64Array | null;
  ele: Float64Array | null;
  speed: Float64Array | null;
  hr: Float64Array | null;
  cadence: Float64Array | null;
  power: Float64Array | null;
  moving: Uint8Array;
  /** Grade (fraction) from smoothed elevation over distance. */
  grade: Float64Array | null;
  /** Direction of travel (degrees) over ±15 m — marker rotation. */
  heading: Float64Array | null;
  /** Smoothed course (degrees) over ±150 m — camera bearing in the 3D flyover. */
  course: Float64Array | null;
  /** Stopped / paused intervals [tStart, tEnd] of at least 10 s. */
  pauses: [number, number][];
  /** Indices where a new part of the GPS track starts (travelled while paused, WorkoutStreams.breaks). */
  breaks: number[];
  duration: number;
  totalDist: number;
  hasGps: boolean;
}

function floats(a: (number | null)[] | undefined, n: number): Float64Array | null {
  if (!a || a.length !== n) return null;
  const out = new Float64Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    const v = a[i];
    if (v === null || v === undefined || !Number.isFinite(v)) out[i] = NaN;
    else {
      out[i] = v;
      any = true;
    }
  }
  return any ? out : null;
}

/** Fill gaps by holding the previous (then next) value. */
function holdFill(a: Float64Array): void {
  let last = NaN;
  for (let i = 0; i < a.length; i++) {
    if (isNum(a[i]!)) last = a[i]!;
    else a[i] = last;
  }
  let next = NaN;
  for (let i = a.length - 1; i >= 0; i--) {
    if (isNum(a[i]!)) next = a[i]!;
    else a[i] = next;
  }
}

function smooth(v: Float64Array, half: number): Float64Array {
  const n = v.length;
  const out = new Float64Array(n);
  let sum = 0;
  let cnt = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    while (hi < b) {
      hi++;
      if (isNum(v[hi]!)) {
        sum += v[hi]!;
        cnt++;
      }
    }
    while (lo < a) {
      if (isNum(v[lo]!)) {
        sum -= v[lo]!;
        cnt--;
      }
      lo++;
    }
    out[i] = cnt ? sum / cnt : NaN;
  }
  return out;
}

/** Fractional index where a non-decreasing array reaches `x`. */
export function fracIndex(arr: Float64Array, x: number): number {
  const n = arr.length;
  if (!n) return 0;
  if (x <= arr[0]!) return 0;
  if (x >= arr[n - 1]!) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const a = arr[lo]!;
  const b = arr[hi]!;
  return b > a ? lo + (x - a) / (b - a) : lo;
}

/** Value at a fractional index (linear; a missing neighbour yields the other one). */
export function valueAt(arr: Float64Array | null, fi: number): number {
  if (!arr || !arr.length) return NaN;
  const i = Math.max(0, Math.min(arr.length - 1, Math.floor(fi)));
  const j = Math.min(arr.length - 1, i + 1);
  const f = fi - i;
  const a = arr[i]!;
  const b = arr[j]!;
  if (isNum(a) && isNum(b)) return a + (b - a) * f;
  return isNum(a) ? a : b;
}

export const indexAtTime = (P: Prepared, t: number) => fracIndex(P.t, t);
export const indexAtDist = (P: Prepared, d: number) => (P.dist ? fracIndex(P.dist, d) : 0);

/** [lon, lat] at a fractional index. */
export function lngLatAt(P: Prepared, fi: number): [number, number] | null {
  if (!P.lat || !P.lon) return null;
  return [valueAt(P.lon, fi), valueAt(P.lat, fi)];
}

export function headingAt(P: Prepared, fi: number, course = false): number {
  const h = course ? P.course : P.heading;
  if (!h) return 0;
  const i = Math.max(0, Math.min(P.n - 1, Math.floor(fi)));
  const j = Math.min(P.n - 1, i + 1);
  return lerpAngle(h[i]!, h[j]!, fi - i);
}

function positionAtDist(P: { dist: Float64Array; lat: Float64Array; lon: Float64Array }, d: number): [number, number] {
  const fi = fracIndex(P.dist, d);
  return [valueAt(P.lat, fi), valueAt(P.lon, fi)];
}

function headings(dist: Float64Array, lat: Float64Array, lon: Float64Array, half: number): Float64Array {
  const n = dist.length;
  const out = new Float64Array(n);
  const P = { dist, lat, lon };
  let prev = 0;
  let found = false;
  for (let i = 0; i < n; i++) {
    const d = dist[i]!;
    const [la1, lo1] = positionAtDist(P, d - half);
    const [la2, lo2] = positionAtDist(P, d + half);
    if (haversine(la1, lo1, la2, lo2) > half * 0.2) {
      prev = bearing(la1, lo1, la2, lo2);
      if (!found) {
        out.fill(prev, 0, i);
        found = true;
      }
    }
    out[i] = prev;
  }
  return out;
}

/** Grade per sample from elevation resampled on a 10 m distance grid, smoothed over ~70 m. */
function grades(dist: Float64Array, ele: Float64Array): Float64Array | null {
  const n = dist.length;
  const total = dist[n - 1]!;
  const step = 10;
  if (!(total > 5 * step)) return null;
  const m = Math.floor(total / step) + 1;
  const raw = new Float64Array(m);
  for (let k = 0; k < m; k++) raw[k] = valueAt(ele, fracIndex(dist, k * step));
  holdFill(raw);
  const e = smooth(raw, 3);
  const g = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const a = Math.max(0, k - 2);
    const b = Math.min(m - 1, k + 2);
    g[k] = b > a ? Math.max(-0.45, Math.min(0.45, (e[b]! - e[a]!) / ((b - a) * step))) : 0;
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = g[Math.max(0, Math.min(m - 1, Math.round(dist[i]! / step)))]!;
  return out;
}

/** Stopped intervals: runs of non-moving segments lasting ≥ minS (s), merged when < 3 s apart. */
export function pausesOf(t: Float64Array, moving: Uint8Array, minS = 10): [number, number][] {
  const raw: [number, number][] = [];
  let start = -1;
  for (let i = 1; i < t.length; i++) {
    if (!moving[i]) {
      if (start < 0) start = t[i - 1]!;
    } else if (start >= 0) {
      raw.push([start, t[i - 1]!]);
      start = -1;
    }
  }
  if (start >= 0) raw.push([start, t[t.length - 1]!]);
  const merged: [number, number][] = [];
  for (const p of raw) {
    const last = merged[merged.length - 1];
    if (last && p[0] - last[1] < 3) last[1] = p[1];
    else merged.push([p[0], p[1]]);
  }
  return merged.filter(([a, b]) => b - a >= minS);
}

export function prepareStreams(s: WorkoutStreams): Prepared | null {
  const n = s.t.length;
  if (n < 2) return null;
  const t = Float64Array.from(s.t);
  const moving = new Uint8Array(n);
  if (s.moving && s.moving.length === n) for (let i = 0; i < n; i++) moving[i] = s.moving[i] ? 1 : 0;
  else moving.fill(1);
  const lat = floats(s.lat, n);
  const lon = floats(s.lon, n);
  const hasGps = !!lat && !!lon;
  if (hasGps) {
    holdFill(lat);
    holdFill(lon);
  }
  const dist = floats(s.dist, n);
  if (dist) holdFill(dist);
  const ele = floats(s.ele, n);
  if (ele) holdFill(ele);
  const breaks = (s.breaks ?? []).filter((k) => k > 0 && k < n);
  // grades from the elevation without the jump between track parts (that is no climb)
  const grade = dist && ele ? grades(dist, breaks.length ? stitchElevation(ele, breaks) : ele) : null;
  return {
    n,
    t,
    dist,
    lat: hasGps ? lat : null,
    lon: hasGps ? lon : null,
    ele,
    speed: floats(s.speed, n),
    hr: floats(s.hr, n),
    cadence: floats(s.cadence, n),
    power: floats(s.power, n),
    moving,
    grade,
    heading: hasGps && dist ? headings(dist, lat!, lon!, 15) : null,
    course: hasGps && dist ? headings(dist, lat!, lon!, 150) : null,
    pauses: pausesOf(t, moving),
    breaks,
    duration: t[n - 1]!,
    totalDist: dist ? dist[n - 1]! : 0,
    hasGps,
  };
}

/** Move a time out of a pause interval (to its end); returns the same time otherwise. */
export function skipPause(P: Prepared, time: number): number {
  for (const [a, b] of P.pauses) {
    if (time >= a && time < b - 0.5) return b;
    if (a > time) break;
  }
  return time;
}

// ---------------------------------------------------------------------------
// Decimation for charts
// ---------------------------------------------------------------------------

export interface Buckets {
  /** First and last (inclusive) sample index of each bucket. */
  from: Int32Array;
  to: Int32Array;
  /** Representative (middle) sample of each bucket. */
  mid: Int32Array;
}

/** Split the samples into at most `max` consecutive buckets of equal size. */
export function buckets(n: number, max = 1000): Buckets {
  const k = Math.max(1, Math.ceil(n / max));
  const m = Math.ceil(n / k);
  const from = new Int32Array(m);
  const to = new Int32Array(m);
  const mid = new Int32Array(m);
  for (let b = 0; b < m; b++) {
    from[b] = b * k;
    to[b] = Math.min(n - 1, (b + 1) * k - 1);
    mid[b] = (from[b]! + to[b]!) >> 1;
  }
  return { from, to, mid };
}

/** NaN-aware mean of `arr` per bucket. */
export function bucketMean(arr: Float64Array, B: Buckets): Float64Array {
  const out = new Float64Array(B.from.length);
  for (let b = 0; b < out.length; b++) {
    let s = 0;
    let c = 0;
    for (let i = B.from[b]!; i <= B.to[b]!; i++) {
      const v = arr[i]!;
      if (isNum(v)) {
        s += v;
        c++;
      }
    }
    out[b] = c ? s / c : NaN;
  }
  return out;
}

/** Share of moving samples per bucket. */
export function bucketMoving(P: Prepared, B: Buckets): Float64Array {
  const out = new Float64Array(B.from.length);
  for (let b = 0; b < out.length; b++) {
    let c = 0;
    for (let i = B.from[b]!; i <= B.to[b]!; i++) c += P.moving[i]!;
    out[b] = c / (B.to[b]! - B.from[b]! + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Range statistics (selection, splits, efforts)
// ---------------------------------------------------------------------------

export interface RangeStats {
  i0: number;
  i1: number;
  elapsedS: number;
  movingS: number;
  distanceM: number | null;
  avgSpeed: number | null;
  /** Grade adjusted speed (foot sports with elevation). */
  gapSpeed: number | null;
  maxSpeed: number | null;
  avgHr: number | null;
  maxHr: number | null;
  gainM: number | null;
  lossM: number | null;
  avgGrade: number | null;
  avgCadence: number | null;
  avgPower: number | null;
  maxPower: number | null;
}

function segMean(arr: Float64Array, i: number): number {
  const a = arr[i - 1]!;
  const b = arr[i]!;
  if (isNum(a) && isNum(b)) return (a + b) / 2;
  return isNum(a) ? a : b;
}

/** Statistics of the samples i0..i1 (integer indices, i0 < i1). */
export function rangeStats(P: Prepared, i0: number, i1: number, sport: string): RangeStats {
  const a = Math.max(0, Math.min(P.n - 1, Math.round(Math.min(i0, i1))));
  const b = Math.max(0, Math.min(P.n - 1, Math.round(Math.max(i0, i1))));
  let movingS = 0;
  const acc = { hr: [0, 0], cad: [0, 0], pw: [0, 0] };
  let maxHr = -Infinity;
  let maxPw = -Infinity;
  let maxSp = -Infinity;
  let flat = 0;
  const foot = (GAP_SPORTS as readonly string[]).includes(sport);
  for (let i = a + 1; i <= b; i++) {
    const dt = Math.min(Math.max(0, P.t[i]! - P.t[i - 1]!), 600);
    if (P.moving[i]) {
      movingS += dt;
      if (P.dist && foot && P.grade) {
        const dd = P.dist[i]! - P.dist[i - 1]!;
        if (dd > 0) flat += dd * gradeCostFactor(P.grade[i]!, sport);
      }
    }
    const w = Math.min(dt, 30);
    const add = (arr: Float64Array | null, slot: number[]) => {
      if (!arr) return;
      const v = segMean(arr, i);
      if (isNum(v)) {
        slot[0]! += v * w;
        slot[1]! += w;
      }
    };
    add(P.hr, acc.hr);
    add(P.cadence, acc.cad);
    add(P.power, acc.pw);
    if (P.hr && isNum(P.hr[i]!)) maxHr = Math.max(maxHr, P.hr[i]!);
    if (P.power && isNum(P.power[i]!)) maxPw = Math.max(maxPw, P.power[i]!);
    if (P.speed && P.moving[i] && isNum(P.speed[i]!)) maxSp = Math.max(maxSp, P.speed[i]!);
  }
  let gain: number | null = null;
  let loss: number | null = null;
  if (P.ele) {
    gain = 0;
    loss = 0;
    let ref = NaN;
    const e = P.ele;
    for (let i = a; i <= b; i++) {
      const v = e[i]!;
      if (!isNum(v)) continue;
      if (!isNum(ref)) ref = v;
      else if (v - ref >= 2) {
        gain += v - ref;
        ref = v;
      } else if (ref - v >= 2) {
        loss += ref - v;
        ref = v;
      }
    }
  }
  const distanceM = P.dist ? P.dist[b]! - P.dist[a]! : null;
  const mean = (s: number[]) => (s[1]! > 0 ? s[0]! / s[1]! : null);
  return {
    i0: a,
    i1: b,
    elapsedS: P.t[b]! - P.t[a]!,
    movingS,
    distanceM,
    avgSpeed: distanceM !== null && movingS > 0 ? distanceM / movingS : null,
    gapSpeed: foot && P.grade && movingS > 0 && flat > 0 ? flat / movingS : null,
    maxSpeed: maxSp > -Infinity ? maxSp : null,
    avgHr: mean(acc.hr),
    maxHr: maxHr > -Infinity ? maxHr : null,
    gainM: gain,
    lossM: loss,
    avgGrade: P.ele && distanceM && distanceM > 0 ? (P.ele[b]! - P.ele[a]!) / distanceM : null,
    avgCadence: mean(acc.cad),
    avgPower: mean(acc.pw),
    maxPower: maxPw > -Infinity ? maxPw : null,
  };
}

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

/** Seconds of moving time per bin of `value(i)`; edges ascending, values outside go to the first/last bin. */
export function timeHistogram(P: Prepared, value: (i: number) => number, edges: number[], movingOnly = true): number[] {
  const bins = new Array<number>(Math.max(0, edges.length - 1)).fill(0);
  if (!bins.length) return bins;
  for (let i = 1; i < P.n; i++) {
    if (movingOnly && !P.moving[i]) continue;
    const dt = Math.min(Math.max(0, P.t[i]! - P.t[i - 1]!), 30);
    const v = value(i);
    if (!isNum(v) || !dt) continue;
    let k = 0;
    while (k < bins.length - 1 && v >= edges[k + 1]!) k++;
    bins[k]! += dt;
  }
  return bins;
}

/** p-quantile of the finite values of an array. */
export function quantile(values: ArrayLike<number>, p: number): number {
  const v: number[] = [];
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i]!)) v.push(values[i]!);
  if (!v.length) return NaN;
  v.sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.max(0, Math.floor(p * (v.length - 1))))]!;
}

// ---------------------------------------------------------------------------
// Line simplification (map rendering)
// ---------------------------------------------------------------------------

/** Douglas–Peucker indices (always keeps first and last) with a tolerance in meters. */
export function simplifyIndices(lat: Float64Array, lon: Float64Array, toleranceM: number): number[] {
  const n = lat.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  let latSum = 0;
  for (let i = 0; i < n; i++) latSum += lat[i]!;
  const ky = EARTH_R * RAD;
  const kx = ky * Math.cos((latSum / n) * RAD);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = toleranceM * toleranceM;
  const stack = [0, n - 1];
  while (stack.length) {
    const last = stack.pop()!;
    const first = stack.pop()!;
    const ax = lon[first]! * kx;
    const ay = lat[first]! * ky;
    const bx = lon[last]! * kx;
    const by = lat[last]! * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = 0;
    let idx = -1;
    for (let i = first + 1; i < last; i++) {
      const px = lon[i]! * kx;
      const py = lat[i]! * ky;
      let qx = ax;
      let qy = ay;
      if (len2 > 0) {
        const f = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        qx = ax + dx * f;
        qy = ay + dy * f;
      }
      const d = (px - qx) ** 2 + (py - qy) ** 2;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tol2) {
      keep[idx] = 1;
      stack.push(first, idx, idx, last);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

function parseColor(c: string): [number, number, number] {
  const s = c.trim();
  if (s.startsWith('#')) {
    const h = s.length === 4 ? s.replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3') : s;
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (m) {
    const [r, g, b] = m[1]!.split(',').map((x) => Number.parseFloat(x));
    return [r ?? 0, g ?? 0, b ?? 0];
  }
  return [128, 128, 128];
}

/** Color at f (0..1) of a ramp of evenly spaced colors, interpolated in RGB. */
export function rampColor(ramp: string[], f: number): string {
  if (!ramp.length) return '#888888';
  if (ramp.length === 1 || !Number.isFinite(f)) return ramp[0]!;
  const x = Math.max(0, Math.min(1, f)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  const a = parseColor(ramp[i]!);
  const b = parseColor(ramp[i + 1]!);
  const k = x - i;
  const c = a.map((v, j) => Math.round(v + (b[j]! - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
