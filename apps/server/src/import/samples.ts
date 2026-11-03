import { gunzipJson, gzipJson } from '../lib/gzip';

/**
 * Sensor time series a device recorded during a workout (FIT `record` messages), stored per workout in
 * workout_samples. Times are absolute unix seconds; missing values are NaN in memory and null in storage.
 * Cadence is already normalised: rpm for cycling, steps/min for foot sports.
 */
export interface SensorSamples {
  t: Float64Array;
  hr: Float64Array | null;
  power: Float64Array | null;
  cadence: Float64Array | null;
  /** Cumulative distance (m) as measured by the device. */
  dist: Float64Array | null;
}

interface Stored {
  v: 1;
  t: number[];
  hr?: (number | null)[];
  power?: (number | null)[];
  cadence?: (number | null)[];
  dist?: (number | null)[];
}

const COLUMNS = ['hr', 'power', 'cadence', 'dist'] as const;

export function encodeSamples(s: SensorSamples): Uint8Array {
  const out: Stored = { v: 1, t: Array.from(s.t, (x) => Math.round(x * 1000) / 1000) };
  for (const k of COLUMNS) {
    const col = s[k];
    if (col && col.some((x) => x === x))
      out[k] = Array.from(col, (x) => (x === x ? Math.round(x * 100) / 100 : null));
  }
  return gzipJson(out);
}

export function decodeSamples(blob: Uint8Array): SensorSamples {
  const s = gunzipJson<Stored>(blob);
  const col = (a: (number | null)[] | undefined) =>
    a ? Float64Array.from(a, (x) => (x === null ? NaN : x)) : null;
  return {
    t: Float64Array.from(s.t),
    hr: col(s.hr),
    power: col(s.power),
    cadence: col(s.cadence),
    dist: col(s.dist),
  };
}

/** Point samples of one column without the missing values (input for derive's sampleAt). */
export function seriesOf(
  s: SensorSamples,
  key: 'hr' | 'power' | 'cadence',
): { t: Float64Array; v: Float64Array } | null {
  const col = s[key];
  if (!col) return null;
  const t: number[] = [];
  const v: number[] = [];
  for (let i = 0; i < col.length; i++) {
    const x = col[i]!;
    if (x === x) {
      t.push(s.t[i]!);
      v.push(x);
    }
  }
  return t.length ? { t: Float64Array.from(t), v: Float64Array.from(v) } : null;
}

/** Cumulative distance → per-step distance intervals (input for derive's cumulativeAt). */
export function distanceIntervals(
  s: SensorSamples,
): { s: Float64Array; e: Float64Array; v: Float64Array } | null {
  const d = s.dist;
  if (!d) return null;
  const st: number[] = [];
  const en: number[] = [];
  const v: number[] = [];
  let prevT = NaN;
  let prevD = NaN;
  for (let i = 0; i < d.length; i++) {
    const x = d[i]!;
    if (x !== x) continue;
    if (prevD === prevD && x > prevD && s.t[i]! > prevT) {
      st.push(prevT);
      en.push(s.t[i]!);
      v.push(x - prevD);
    }
    if (!(prevD === prevD) || x >= prevD) {
      prevD = x;
      prevT = s.t[i]!;
    }
  }
  return v.length ? { s: Float64Array.from(st), e: Float64Array.from(en), v: Float64Array.from(v) } : null;
}
