/**
 * Small automatic tags of an activity: what kind of training it was, the countries it took place in and the
 * weather. Each one only exists when the data for it does.
 */

export type TrainingKind = 'intervals' | 'long' | 'tempo' | 'easy' | 'recovery';
export const TRAINING_KINDS: readonly TrainingKind[] = ['intervals', 'long', 'tempo', 'easy', 'recovery'];

/** Endurance sports the training kind is estimated for (a walk or a strength session has none). */
const KIND_SPORTS = new Set(['run', 'ride', 'swim', 'row', 'nordic_ski']);

/** From this moving time (s) or distance (m) an activity counts as a long one. */
const LONG: Record<string, { s: number; m: number }> = {
  run: { s: 90 * 60, m: 18_000 },
  ride: { s: 180 * 60, m: 80_000 },
  swim: { s: 75 * 60, m: 3_000 },
  row: { s: 90 * 60, m: 15_000 },
  nordic_ski: { s: 150 * 60, m: 25_000 },
};

export interface TrainingKindInput {
  sport: string;
  movingS: number | null;
  distanceM: number | null;
  /** Seconds in heart-rate zones 1..5, null without a usable heart-rate stream. */
  zones: number[] | null;
  /** Hard repetitions found in the pace / power stream (see hardReps), null when unknown. */
  hardReps: number | null;
}

/**
 * What kind of training an activity was, or null when the data does not say:
 *  - intervals: at least three hard repetitions with easier stretches between them,
 *  - long: long for the sport by time or distance,
 *  - tempo: a quarter of the time in zones 4–5, or half of it in zones 3–5,
 *  - recovery: short and at least 80 % in zone 1,
 *  - easy: at least 70 % in zones 1–2.
 */
export function trainingKind(i: TrainingKindInput): TrainingKind | null {
  if (!KIND_SPORTS.has(i.sport)) return null;
  const moving = i.movingS ?? 0;
  if (moving < 10 * 60) return null;
  if ((i.hardReps ?? 0) >= 3) return 'intervals';
  const long = LONG[i.sport];
  if (long && (moving >= long.s || (i.distanceM ?? 0) >= long.m)) return 'long';
  const z = i.zones;
  const sum = z ? z.reduce((a, b) => a + b, 0) : 0;
  // the zones must cover most of the activity
  if (!z || z.length < 5 || sum < 0.5 * moving) return null;
  const hi = (z[3]! + z[4]!) / sum;
  const mid = z[2]! / sum;
  if (hi >= 0.25 || hi + mid >= 0.5) return 'tempo';
  if (z[0]! / sum >= 0.8 && moving <= 50 * 60) return 'recovery';
  if ((z[0]! + z[1]!) / sum >= 0.7) return 'easy';
  return null;
}

/**
 * Hard repetitions in a pace or power stream: stretches of at least 40 s clearly above the activity's median
 * (≥ 112 %), each after at least 30 s that was not hard. `t` in seconds, samples while not moving left out by the
 * caller: a gap of 30 s or more is a standing rest. Hard time above 60 % of the activity is a hard steady effort,
 * not intervals (0).
 */
export function hardReps(t: ArrayLike<number>, v: ArrayLike<number | null>): number {
  const ts: number[] = [];
  const vs: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const x = v[i];
    if (x !== null && x !== undefined && Number.isFinite(x) && x > 0) {
      ts.push(t[i]!);
      vs.push(x);
    }
  }
  if (vs.length < 120) return 0;
  const median = [...vs].sort((a, b) => a - b)[vs.length >> 1]!;
  // 20 s moving average
  const smooth = new Float64Array(vs.length);
  let lo = 0;
  let acc = 0;
  for (let i = 0; i < vs.length; i++) {
    acc += vs[i]!;
    while (ts[i]! - ts[lo]! > 20) acc -= vs[lo++]!;
    smooth[i] = acc / (i - lo + 1);
  }
  let reps = 0;
  let hardTime = 0;
  let hardStart = -1;
  let restStart = ts[0]!;
  let rested = true;
  // the hard stretch ends at `end`: from 40 s it is hard time, and a repetition when it followed a rest
  const close = (end: number) => {
    const len = end - hardStart;
    if (len >= 40) {
      hardTime += len;
      if (rested) reps++;
    }
    hardStart = -1;
    restStart = end;
  };
  for (let i = 0; i < vs.length; i++) {
    // standing still ends the stretch at its last moving sample, so the rest is neither hard time nor missing
    if (hardStart >= 0 && i > 0 && ts[i]! - ts[i - 1]! >= 30) close(ts[i - 1]!);
    if (smooth[i]! >= 1.12 * median) {
      if (hardStart < 0) {
        hardStart = ts[i]!;
        rested = ts[i]! - restStart >= 30;
      }
    } else if (hardStart >= 0) close(ts[i]!);
  }
  if (hardStart >= 0) close(ts[ts.length - 1]!);
  const total = ts[ts.length - 1]! - ts[0]!;
  return total > 0 && hardTime / total > 0.6 ? 0 : reps;
}

export interface WorkoutWeather {
  temperatureC: number;
  humidityPct: number | null;
}
