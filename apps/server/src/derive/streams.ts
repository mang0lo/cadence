import type { WorkoutStreams } from '@cadence/shared';
import { haversine } from '../lib/geo';
import type { Track } from '../import/track';

/** Point samples (absolute unix seconds, sorted). */
export interface Samples {
  t: Float64Array;
  v: Float64Array;
}

/** Interval samples (start/end unix seconds + value), sorted by start. */
export interface Intervals {
  s: Float64Array;
  e: Float64Array;
  v: Float64Array;
}

export interface StreamInput {
  sport: string;
  startTs: number;
  endTs: number;
  track: Track | null;
  hr: Samples | null;
  power: Samples | null;
  /** Cycling cadence samples (rpm). */
  cadence: Samples | null;
  /** Step count intervals → running/walking cadence (steps/min). */
  steps: Intervals | null;
  /** Distance records (m) for GPS-less workouts. */
  distance: Intervals | null;
  /** Apple's own distance for the workout (WorkoutStatistics), used to calibrate GPS distance. */
  appleDistanceM: number | null;
  /** Paused intervals (absolute ts). */
  pauses: [number, number][];
}

/** Full-resolution arrays used by the metric computations (NaN = missing). */
export interface BuiltStreams {
  gps: boolean;
  /** Seconds since workout start. */
  t: Float64Array;
  lat: Float64Array | null;
  lon: Float64Array | null;
  ele: Float64Array | null;
  dist: Float64Array | null;
  speed: Float64Array | null;
  hr: Float64Array | null;
  cadence: Float64Array | null;
  power: Float64Array | null;
  moving: Uint8Array;
  /** GPS distance before calibration (m). */
  rawDistanceM: number | null;
  /** Factor applied to GPS distance to match Apple's distance (1 = none). */
  distanceScale: number;
  /** Indices where a new part of the GPS track starts (see isTrackBreak); empty without breaks. */
  breaks: number[];
}

/** Speed threshold (m/s) above which an athlete counts as moving. */
export function movingThreshold(sport: string): number {
  switch (sport) {
    case 'run':
    case 'track_and_field':
      return 0.8;
    case 'walk':
    case 'hike':
    case 'wheelchair':
      return 0.35;
    case 'ride':
    case 'handcycle':
      return 1.0;
    case 'swim':
      return 0.15;
    case 'alpine_ski':
    case 'snowboard':
    case 'nordic_ski':
      return 0.8;
    default:
      return 0.4;
  }
}

/** Physiological / mechanical upper bound for point-to-point speed (m/s); faster fixes are GPS glitches. */
export function maxPlausibleSpeed(sport: string): number {
  switch (sport) {
    case 'run':
    case 'track_and_field':
      return 12;
    case 'walk':
    case 'hike':
      return 8;
    case 'ride':
    case 'handcycle':
      return 35;
    case 'swim':
      return 4;
    case 'row':
    case 'paddle':
      return 8;
    case 'alpine_ski':
    case 'snowboard':
      return 45;
    default:
      return 40;
  }
}

/** Interpolate point samples at absolute times `at`; no interpolation across gaps > maxGap (s). */
export function sampleAt(series: Samples, at: Float64Array, maxGap: number, edge = 5): Float64Array {
  const out = new Float64Array(at.length).fill(NaN);
  const st = series.t;
  const sv = series.v;
  const m = st.length;
  if (!m) return out;
  let j = 0;
  for (let k = 0; k < at.length; k++) {
    const x = at[k]!;
    while (j + 1 < m && st[j + 1]! <= x) j++;
    if (x < st[0]!) {
      if (st[0]! - x <= edge) out[k] = sv[0]!;
      continue;
    }
    if (j === m - 1) {
      if (x - st[j]! <= edge) out[k] = sv[j]!;
      continue;
    }
    const t0 = st[j]!;
    const t1 = st[j + 1]!;
    const gap = t1 - t0;
    if (gap <= maxGap) out[k] = gap > 0 ? sv[j]! + ((sv[j + 1]! - sv[j]!) * (x - t0)) / gap : sv[j]!;
    else if (x - t0 <= edge) out[k] = sv[j]!;
    else if (t1 - x <= edge) out[k] = sv[j + 1]!;
  }
  return out;
}

/** Cumulative sum of interval values at times `at`, assuming each value is spread evenly over its interval. */
export function cumulativeAt(iv: Intervals, at: Float64Array): Float64Array {
  type Ev = [time: number, rateDelta: number, impulse: number];
  const ev: Ev[] = [];
  for (let i = 0; i < iv.s.length; i++) {
    const s = iv.s[i]!;
    const e = iv.e[i]!;
    const v = iv.v[i]!;
    if (!(v > 0)) continue;
    if (e > s) {
      const r = v / (e - s);
      ev.push([s, r, 0], [e, -r, 0]);
    } else ev.push([s, 0, v]);
  }
  ev.sort((a, b) => a[0] - b[0]);
  const out = new Float64Array(at.length);
  let cum = 0;
  let rate = 0;
  let last = ev.length ? ev[0]![0] : 0;
  let j = 0;
  for (let k = 0; k < at.length; k++) {
    const x = at[k]!;
    while (j < ev.length && ev[j]![0] <= x) {
      const [time, dr, imp] = ev[j]!;
      cum += rate * (time - last) + imp;
      rate += dr;
      last = time;
      j++;
    }
    out[k] = cum + (x > last ? rate * (x - last) : 0);
  }
  return out;
}

/** Rate (per minute) of the interval covering each time `at` – e.g. steps/min from StepCount samples. */
export function rateAt(iv: Intervals, at: Float64Array, minDurationS = 2): Float64Array {
  const out = new Float64Array(at.length).fill(NaN);
  let j = 0;
  for (let k = 0; k < at.length; k++) {
    const x = at[k]!;
    while (j < iv.s.length && iv.e[j]! < x) j++;
    // scan the (few) intervals that may cover x
    for (let q = j; q < iv.s.length && iv.s[q]! <= x; q++) {
      const d = iv.e[q]! - iv.s[q]!;
      if (iv.e[q]! >= x && d >= minDurationS) {
        out[k] = (iv.v[q]! / d) * 60;
        break;
      }
    }
  }
  return out;
}

/** Centered moving average over ±halfWindow samples, NaN-aware. */
export function smooth(v: Float64Array, halfWindow: number): Float64Array {
  const n = v.length;
  const out = new Float64Array(n);
  let sum = 0;
  let cnt = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - halfWindow);
    const b = Math.min(n - 1, i + halfWindow);
    while (hi < b) {
      hi++;
      const x = v[hi]!;
      if (x === x) {
        sum += x;
        cnt++;
      }
    }
    while (lo < a) {
      const x = v[lo]!;
      if (x === x) {
        sum -= x;
        cnt--;
      }
      lo++;
    }
    out[i] = cnt ? sum / cnt : NaN;
  }
  return out;
}

function inPauses(pauses: [number, number][], ts: number): boolean {
  for (const [a, b] of pauses) if (ts >= a && ts < b) return true;
  return false;
}

/** Turn pause/resume (and motion paused/resumed) events into paused intervals. */
export function pausedIntervals(events: { type: string; ts: number }[], endTs: number): [number, number][] {
  const out: [number, number][] = [];
  let pausedAt: number | null = null;
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    if (e.type === 'pause' || e.type === 'motion_paused') {
      if (pausedAt === null) pausedAt = e.ts;
    } else if (e.type === 'resume' || e.type === 'motion_resumed') {
      if (pausedAt !== null && e.ts > pausedAt) out.push([pausedAt, e.ts]);
      pausedAt = null;
    }
  }
  if (pausedAt !== null && endTs > pausedAt) out.push([pausedAt, endTs]);
  return out;
}

/** Straight-line gaps shorter than this (m) never split a track. */
const BREAK_MIN_M = 250;
/** A gap this long splits the track even without a pause (the position was lost for a long way). */
const BREAK_ALWAYS_M = 5000;

/**
 * Whether the step between two consecutive GPS fixes is a break between two parts of a track rather than
 * distance covered: a jump across a pause (train, car, ferry while the workout was paused), a very long gap,
 * or an implausibly fast jump that persisted (the glitch filter kept it). Distance and elevation are not
 * counted across a break and maps draw the parts separately.
 */
export function isTrackBreak(distanceM: number, dtS: number, spansPause: boolean, maxSpeed: number): boolean {
  if (!(distanceM >= BREAK_MIN_M)) return false;
  return spansPause || distanceM >= BREAK_ALWAYS_M || (dtS > 0 && distanceM / dtS > maxSpeed);
}

/** Indices of usable GPS fixes: inside the workout window, accurate enough, no impossible jumps. */
export function cleanTrackIndices(
  tr: Track,
  startTs: number,
  endTs: number,
  sport: string,
  pauses: [number, number][] = [],
): number[] {
  const vmax = maxPlausibleSpeed(sport);
  let keep: number[] = [];
  let rejectedInRow = 0;
  let firstRejected = -1;
  for (let i = 0; i < tr.t.length; i++) {
    const t = tr.t[i]!;
    if (t < startTs - 30 || t > endTs + 30) continue;
    const acc = tr.hAcc ? tr.hAcc[i]! : NaN;
    if (acc > 65) continue;
    if (keep.length) {
      const p = keep[keep.length - 1]!;
      const dt = t - tr.t[p]!;
      if (dt <= 0) continue;
      const d = haversine(tr.lat[p]!, tr.lon[p]!, tr.lat[i]!, tr.lon[i]!);
      // a fix after a pause may be far away (travelled while paused): a new part of the track, not a glitch
      if (d / dt > vmax && !inPauses(pauses, tr.t[p]! + dt / 2)) {
        if (rejectedInRow < 8) {
          if (!rejectedInRow) firstRejected = i;
          rejectedInRow++;
          continue;
        }
        // The jump persisted. When the only fix before it is the first one, that one was a stale (cached) position:
        // drop it and start over from the first rejected fix.
        if (keep.length === 1) {
          keep = [];
          rejectedInRow = 0;
          i = firstRejected - 1;
          continue;
        }
      }
    }
    rejectedInRow = 0;
    keep.push(i);
  }
  return keep;
}

/** Build the merged time series of a workout (see WorkoutStreams). */
export function buildStreams(inp: StreamInput): BuiltStreams | null {
  const { startTs, endTs, sport } = inp;
  const thr = movingThreshold(sport);
  const idx = inp.track ? cleanTrackIndices(inp.track, startTs, endTs, sport, inp.pauses) : [];

  if (idx.length >= 10) {
    const tr = inp.track!;
    const n = idx.length;
    const abs = new Float64Array(n);
    const t = new Float64Array(n);
    const lat = new Float64Array(n);
    const lon = new Float64Array(n);
    const ele = tr.ele ? new Float64Array(n) : null;
    const dist = new Float64Array(n);
    const rawSpeed = new Float64Array(n);
    const vmax = maxPlausibleSpeed(sport);
    const breaks: number[] = [];
    for (let k = 0; k < n; k++) {
      const i = idx[k]!;
      abs[k] = tr.t[i]!;
      t[k] = tr.t[i]! - startTs;
      lat[k] = tr.lat[i]!;
      lon[k] = tr.lon[i]!;
      if (ele) ele[k] = tr.ele![i]!;
      if (k) {
        const d = haversine(lat[k - 1]!, lon[k - 1]!, lat[k]!, lon[k]!);
        const dt = t[k]! - t[k - 1]!;
        if (isTrackBreak(d, dt, inPauses(inp.pauses, abs[k - 1]! + dt / 2), vmax)) {
          // travelled while paused (or the position was lost): not part of the workout's distance
          breaks.push(k);
          dist[k] = dist[k - 1]!;
          rawSpeed[k] = NaN;
        } else {
          dist[k] = dist[k - 1]! + d;
          rawSpeed[k] = dt > 0 ? d / dt : NaN;
        }
      }
    }
    rawSpeed[0] = n > 1 ? rawSpeed[1]! : 0;
    // Prefer the receiver's Doppler speed (Apple's <speed> extension), fill gaps from positions.
    const speed0 = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const s = tr.speed ? tr.speed[idx[k]!]! : NaN;
      speed0[k] = s === s && s >= 0 ? s : rawSpeed[k]!;
    }
    // Calibrate to Apple's distance (pedometer/GPS fusion) when it is plausible.
    const rawDistanceM = dist[n - 1]!;
    let scale = 1;
    const apple = inp.appleDistanceM;
    if (apple && rawDistanceM > 0 && Math.abs(apple / rawDistanceM - 1) <= 0.25) scale = apple / rawDistanceM;
    if (scale !== 1) {
      for (let k = 0; k < n; k++) {
        dist[k] = dist[k]! * scale;
        speed0[k] = speed0[k]! * scale;
      }
    }
    const speed = smooth(speed0, 2);
    const moving = new Uint8Array(n);
    const isBreak = new Uint8Array(n);
    for (const k of breaks) isBreak[k] = 1;
    for (let k = 1; k < n; k++) {
      const dt = t[k]! - t[k - 1]!;
      // a segment spanning a manual pause (no fixes while paused) has its midpoint inside the pause
      moving[k] =
        !isBreak[k] &&
        speed[k]! >= thr &&
        dt <= 600 &&
        !inPauses(inp.pauses, abs[k]!) &&
        !inPauses(inp.pauses, abs[k - 1]! + dt / 2)
          ? 1
          : 0;
    }
    if (ele) {
      // fill missing elevation by holding the last known value
      let last = NaN;
      for (let k = 0; k < n; k++) {
        if (ele[k] === ele[k]) last = ele[k]!;
        else ele[k] = last;
      }
      let first = NaN;
      for (let k = n - 1; k >= 0; k--) {
        if (ele[k] === ele[k]) first = ele[k]!;
        else ele[k] = first;
      }
    }
    return {
      gps: true,
      t,
      lat,
      lon,
      ele: ele && ele.some((x) => x === x) ? ele : null,
      dist,
      speed,
      hr: inp.hr ? sampleAt(inp.hr, abs, 30) : null,
      cadence: cadenceAt(inp, abs, moving),
      power: inp.power ? sampleAt(inp.power, abs, 30) : null,
      moving,
      rawDistanceM,
      distanceScale: scale,
      breaks,
    };
  }

  // GPS-less: regular ~5 s grid from HR + distance records.
  const hasDist = !!inp.distance && inp.distance.v.some((v) => v > 0);
  if (!inp.hr?.t.length && !hasDist && !inp.power?.t.length) return null;
  const duration = Math.max(0, endTs - startTs);
  if (duration < 10) return null;
  const step = duration > 6 * 3600 ? 10 : 5;
  const n = Math.floor(duration / step) + 1;
  const abs = new Float64Array(n);
  const t = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    t[k] = Math.min(k * step, duration);
    abs[k] = startTs + t[k]!;
  }
  let dist: Float64Array | null = null;
  let speed: Float64Array | null = null;
  const moving = new Uint8Array(n);
  if (hasDist) {
    dist = cumulativeAt(inp.distance!, abs);
    const total = dist[n - 1]!;
    const apple = inp.appleDistanceM;
    if (apple && total > 0 && Math.abs(apple / total - 1) <= 0.25 && apple !== total) {
      const f = apple / total;
      for (let k = 0; k < n; k++) dist[k] = dist[k]! * f;
    }
    speed = new Float64Array(n);
    const w = 2;
    for (let k = 0; k < n; k++) {
      const a = Math.max(0, k - w);
      const b = Math.min(n - 1, k + w);
      const dt = t[b]! - t[a]!;
      speed[k] = dt > 0 ? (dist[b]! - dist[a]!) / dt : 0;
    }
    for (let k = 1; k < n; k++) moving[k] = speed[k]! >= thr && !inPauses(inp.pauses, abs[k]!) ? 1 : 0;
  } else {
    for (let k = 1; k < n; k++) moving[k] = inPauses(inp.pauses, abs[k]!) ? 0 : 1;
  }
  return {
    gps: false,
    t,
    lat: null,
    lon: null,
    ele: null,
    dist,
    speed,
    hr: inp.hr ? sampleAt(inp.hr, abs, 30) : null,
    cadence: cadenceAt(inp, abs, moving),
    power: inp.power ? sampleAt(inp.power, abs, 30) : null,
    moving,
    rawDistanceM: null,
    distanceScale: 1,
    breaks: [],
  };
}

function cadenceAt(inp: StreamInput, abs: Float64Array, moving: Uint8Array): Float64Array | null {
  if (inp.cadence && inp.cadence.t.length) return sampleAt(inp.cadence, abs, 30);
  if (inp.steps && inp.steps.s.length) {
    // Steps/min only when the step records rate at least half of the moving samples: a few background steps of the
    // phone during part of a run say nothing about its cadence.
    const r = rateAt(inp.steps, abs);
    const anyMoving = moving.includes(1);
    let n = 0;
    let rated = 0;
    for (let k = 0; k < r.length; k++) {
      if (anyMoving && !moving[k]) continue;
      n++;
      if (r[k] === r[k]) rated++;
    }
    return rated > 0 && rated >= 0.5 * n ? r : null;
  }
  return null;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const orNull = (x: number, f: (x: number) => number) => (x === x ? f(x) : null);

/** Compact DTO for storage / API (rounded, NaN → null; optional arrays only when they carry data). */
export function toDto(b: BuiltStreams): WorkoutStreams {
  const out: WorkoutStreams = { t: Array.from(b.t, r1) };
  if (b.lat && b.lon) {
    out.lat = Array.from(b.lat, r6);
    out.lon = Array.from(b.lon, r6);
  }
  if (b.ele) out.ele = Array.from(b.ele, (x) => orNull(x, r1));
  if (b.dist) out.dist = Array.from(b.dist, r1);
  if (b.speed) out.speed = Array.from(b.speed, (x) => orNull(x, r2));
  const series = (a: Float64Array | null) =>
    a && a.some((x) => x === x) ? Array.from(a, (x) => orNull(x, Math.round)) : undefined;
  const hr = series(b.hr);
  if (hr) out.hr = hr;
  const cad = series(b.cadence);
  if (cad) out.cadence = cad;
  const pw = series(b.power);
  if (pw) out.power = pw;
  out.moving = Array.from(b.moving);
  if (b.breaks.length) out.breaks = [...b.breaks];
  return out;
}

/** [start, end) index ranges of the parts of a track (re-exported from @cadence/shared). */
export { trackParts } from '@cadence/shared';
