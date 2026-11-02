/**
 * Small pure helpers for health analytics (moving averages, monthly changes, spread, blood pressure
 * categories). Shared so they can be unit-tested on the server side and used by the web UI.
 */

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

/** Days since 1970-01-01 of a 'YYYY-MM-DD' string (UTC based, no time zone involved). */
export function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function dayFromNumber(n: number): string {
  const dt = new Date(n * 86_400_000);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

export function shiftDay(day: string, n: number): string {
  return dayFromNumber(dayNumber(day) + n);
}

export function mean(values: readonly number[]): number | null {
  if (!values.length) return null;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Sample standard deviation (n − 1); null for fewer than two values. */
export function stdev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values)!;
  let s = 0;
  for (const v of values) s += (v - m) * (v - m);
  return Math.sqrt(s / (values.length - 1));
}

export interface DayValue {
  day: string;
  value: number;
}

/**
 * Trailing mean over a window of calendar days: for every point the mean of all points whose day lies in
 * (day − windowDays, day]. `points` must be sorted ascending by day. Points with fewer than `minPoints`
 * values in their window yield null.
 */
export function rollingMeanByDay(points: readonly DayValue[], windowDays: number, minPoints = 1): (number | null)[] {
  const out: (number | null)[] = new Array(points.length).fill(null);
  const nums = points.map((p) => dayNumber(p.day));
  let lo = 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    sum += points[i]!.value;
    while (nums[lo]! <= nums[i]! - windowDays) {
      sum -= points[lo]!.value;
      lo++;
    }
    const n = i - lo + 1;
    out[i] = n >= minPoints ? sum / n : null;
  }
  return out;
}

export interface MonthlyAverage {
  month: string; // 'YYYY-MM'
  mean: number;
  n: number;
  /** mean − mean of the previous calendar month; null when that month has no data. */
  change: number | null;
}

/** Monthly means of daily values and the change versus the previous calendar month. */
export function monthlyAverages(points: readonly DayValue[]): MonthlyAverage[] {
  const by = new Map<string, number[]>();
  for (const p of points) {
    const k = p.day.slice(0, 7);
    const arr = by.get(k);
    if (arr) arr.push(p.value);
    else by.set(k, [p.value]);
  }
  const months = [...by.keys()].sort();
  const out: MonthlyAverage[] = [];
  let prev: { month: string; mean: number } | null = null;
  for (const month of months) {
    const vals = by.get(month)!;
    const m = mean(vals)!;
    const [y, mo] = month.split('-').map(Number) as [number, number];
    const prevKey = mo === 1 ? `${y - 1}-12` : `${y}-${pad2(mo - 1)}`;
    out.push({ month, mean: m, n: vals.length, change: prev && prev.month === prevKey ? m - prev.mean : null });
    prev = { month, mean: m };
  }
  return out;
}

export interface WindowComparison {
  current: number | null;
  previous: number | null;
  /** current − previous (null when either is missing). */
  diff: number | null;
  /** (current − previous) / |previous| (null when previous is 0 or missing). */
  pct: number | null;
}

export function compareWindows(current: number | null, previous: number | null): WindowComparison {
  const diff = current !== null && previous !== null ? current - previous : null;
  return {
    current,
    previous,
    diff,
    pct: diff !== null && previous !== null && previous !== 0 ? diff / Math.abs(previous) : null,
  };
}

/** Round to `digits` fraction digits (avoids "-0"). */
export function roundTo(v: number, digits = 0): number {
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
}

export type BloodPressureCategory = 'normal' | 'elevated' | 'stage1' | 'stage2' | 'crisis';

/** ACC/AHA categories for a resting blood pressure reading in mmHg. */
export function classifyBloodPressure(systolic: number, diastolic: number): BloodPressureCategory {
  if (systolic > 180 || diastolic > 120) return 'crisis';
  if (systolic >= 140 || diastolic >= 90) return 'stage2';
  if (systolic >= 130 || diastolic >= 80) return 'stage1';
  if (systolic >= 120) return 'elevated';
  return 'normal';
}

/** Minutes after local midnight (0..1439) of a timestamp at offset `tzMin`. */
export function minutesOfDay(ts: number, tzMin: number): number {
  const local = Math.floor(ts) + tzMin * 60;
  return Math.floor((((local % 86400) + 86400) % 86400) / 60);
}

/**
 * Clock time as a signed offset in minutes from local midnight so that times around midnight are
 * continuous: 23:30 → −30, 00:30 → +30, 07:45 → +465. Times from 12:00 on count as the evening before.
 */
export function midnightOffsetMin(ts: number, tzMin: number): number {
  const m = minutesOfDay(ts, tzMin);
  return m >= 720 ? m - 1440 : m;
}

/** BMI from weight (kg) and height (m); null when implausible. */
export function bmi(weightKg: number, heightM: number): number | null {
  if (!(weightKg > 0) || !(heightM > 0.5 && heightM < 2.8)) return null;
  return weightKg / (heightM * heightM);
}

/** Mean of the values whose day lies in [fromDay, toDay]; null when there is none. */
export function meanBetween(points: readonly DayValue[], fromDay: string, toDay: string): number | null {
  const vals: number[] = [];
  for (const p of points) if (p.day >= fromDay && p.day <= toDay) vals.push(p.value);
  return mean(vals);
}

export interface TrailingChange {
  recent: number;
  prior: number;
  /** recent − prior */
  diff: number;
}

/**
 * Change of a sparse measure (weight, body fat …): the mean of the last `windowDays` days up to the latest point
 * versus the mean of the `windowDays` days that ended `lagDays` before it. Null when either window is empty.
 */
export function trailingChange(points: readonly DayValue[], lagDays = 30, windowDays = 14): TrailingChange | null {
  const last = points[points.length - 1];
  if (!last) return null;
  const recent = meanBetween(points, shiftDay(last.day, -(windowDays - 1)), last.day);
  const priorEnd = shiftDay(last.day, -lagDays);
  const prior = meanBetween(points, shiftDay(priorEnd, -(windowDays - 1)), priorEnd);
  return recent === null || prior === null ? null : { recent, prior, diff: recent - prior };
}

/** BMI per day from a weight series (kg) and a height (m); empty without a plausible height. */
export function bmiSeries(weight: readonly DayValue[], heightM: number | null): DayValue[] {
  if (heightM === null) return [];
  const out: DayValue[] = [];
  for (const p of weight) {
    const v = bmi(p.value, heightM);
    if (v !== null) out.push({ day: p.day, value: v });
  }
  return out;
}

/** Lean body mass (kg) = weight × (1 − body fat fraction) on days that have both measurements. */
export function leanMassSeries(weight: readonly DayValue[], bodyFat: readonly DayValue[]): DayValue[] {
  const fat = new Map(bodyFat.map((p) => [p.day, p.value]));
  const out: DayValue[] = [];
  for (const p of weight) {
    const f = fat.get(p.day);
    if (f !== undefined && f >= 0 && f < 1) out.push({ day: p.day, value: p.value * (1 - f) });
  }
  return out;
}
