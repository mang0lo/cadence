import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mean, stdev, type DayValue, type ReadinessDay, type ReadinessFactor, type ReadinessResponse } from '@cadence/shared';
import { run } from '../src/db/db';
import { addDays } from '../src/lib/time';
import {
  CAP,
  READINESS_WEIGHTS,
  createReadinessModel,
  effectOf,
  readinessBand,
  type ReadinessInput,
  type ReadinessNight,
} from '../src/features/health/readiness';
import { nightMeans } from '../src/features/health/readiness-routes';
import { createHealthFixture, ts, type HealthFixture } from './health-fixture';

// ---------------------------------------------------------------------------------------------------------------
// Synthetic athlete: deterministic noise around fixed personal baselines
// ---------------------------------------------------------------------------------------------------------------

const END = '2026-03-31';

function rng(seed: number) {
  let s = seed >>> 0;
  const uniform = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  return () => Math.sqrt(-2 * Math.log(Math.max(uniform(), 1e-12))) * Math.cos(2 * Math.PI * uniform());
}

/** `n` days ending at END, oldest first. */
const daysEndingAt = (n: number, end = END) => Array.from({ length: n }, (_, i) => addDays(end, i - (n - 1)));

interface Options {
  days?: number;
  /** Values of the last day(s), by day offset from END (0 = END, -1 = the day before …). */
  hrvLast?: Record<number, number>;
  rhrLast?: Record<number, number | null>;
  nightLast?: Partial<ReadinessNight>;
  /** Daily load for day index i (0 = oldest); default: 80 every second day. */
  load?: ((i: number, n: number) => number) | null;
  constant?: boolean;
}

function athlete(o: Options = {}): ReadinessInput {
  const n = o.days ?? 90;
  const z = rng(11);
  const noise = (sd: number) => (o.constant ? 0 : sd * z());
  const days = daysEndingAt(n);
  const offset = (i: number) => i - (n - 1);
  const hrv: DayValue[] = days.map((day, i) => ({ day, value: o.hrvLast?.[offset(i)] ?? 50 * Math.exp(noise(0.12)) }));
  const restingHr: DayValue[] = [];
  days.forEach((day, i) => {
    const v = o.rhrLast && offset(i) in o.rhrLast ? o.rhrLast[offset(i)] : 52 + noise(1.6);
    if (v !== null && v !== undefined) restingHr.push({ day, value: v });
  });
  const nights: ReadinessNight[] = days.map((day, i) => ({
    day,
    asleepS: 27_000 + noise(1500),
    inBedS: 29_000,
    efficiency: 0.93,
    midpointMin: 190 + noise(25),
    respiratoryRate: 14.2 + noise(0.4),
    wristTemp: 36 + noise(0.15),
    spo2: 0.965 + noise(0.006),
    ...(offset(i) === 0 ? o.nightLast : {}),
  }));
  const loadFn = o.load === undefined ? (i: number) => (i % 2 === 0 ? 80 : 0) : o.load;
  const loads: DayValue[] = loadFn ? days.flatMap((day, i) => (loadFn(i, n) > 0 ? [{ day, value: loadFn(i, n) }] : [])) : [];
  return { hrv, restingHr, nights, loads, sleepGoalS: 8 * 3600 };
}

const factor = (d: ReadinessDay, key: ReadinessFactor['key']) => d.factors.find((f) => f.key === key)!;
const r1 = (v: number) => Math.round(v * 10) / 10;

describe('readiness model (pure)', () => {
  it('maps scores to bands', () => {
    expect(readinessBand(100)).toBe('ready');
    expect(readinessBand(65)).toBe('ready');
    expect(readinessBand(64)).toBe('normal');
    expect(readinessBand(35)).toBe('normal');
    expect(readinessBand(34)).toBe('easy');
    expect(readinessBand(20)).toBe('easy');
    expect(readinessBand(19)).toBe('recover');
    expect(readinessBand(0)).toBe('recover');
    expect(CAP).toBe(34); // top of 'easy'
  });

  it('turns deviations into bounded effects (one-sided for temperature, respiration and SpO2)', () => {
    expect(effectOf('hrv', 1)).toBe(0.5); // edge of the normal range = half effect
    expect(effectOf('hrv', -3)).toBe(-1);
    expect(effectOf('restingHr', 1)).toBe(-0.5); // a higher resting heart rate is worse
    expect(effectOf('sleep', 4)).toBe(0.5); // oversleeping is capped
    expect(effectOf('sleep', -2)).toBe(-1);
    expect(effectOf('sleepTiming', 0)).toBe(0.5);
    expect(effectOf('sleepTiming', -1)).toBe(0);
    expect(effectOf('sleepTiming', 3)).toBe(-1);
    expect(effectOf('wristTemp', -3)).toBe(0); // cooler than usual is no sign of better recovery
    expect(effectOf('wristTemp', 2)).toBe(-1);
    expect(effectOf('respiratoryRate', 1)).toBe(-0.5);
    expect(effectOf('spo2', 2)).toBe(0);
    expect(effectOf('spo2', -1)).toBe(-0.5);
  });

  it('builds personal baselines from the 60 days before the day (HRV on 7-day means of ln SDNN)', () => {
    const input = athlete();
    const d = createReadinessModel(input).day(END);

    // resting heart rate: mean ± SD of the 60 previous daily values
    const rhrBase = input.restingHr.filter((p) => p.day >= addDays(END, -60) && p.day < END).map((p) => p.value);
    const rhr = factor(d, 'restingHr');
    expect(rhrBase).toHaveLength(60);
    expect(rhr.baselineDays).toBe(60);
    expect(rhr.range!.mean).toBe(r1(mean(rhrBase)!));
    expect(rhr.range!.high).toBe(r1(mean(rhrBase)! + stdev(rhrBase)!));
    expect(rhr.value).toBe(r1(input.restingHr.at(-1)!.value));
    expect(rhr.z).toBeCloseTo((input.restingHr.at(-1)!.value - mean(rhrBase)!) / stdev(rhrBase)!, 1);

    // HRV: 7-day means of ln(SDNN) for each of the 60 previous days
    const ln = new Map(input.hrv.map((p) => [p.day, Math.log(p.value)]));
    const m7 = (day: string) => mean(Array.from({ length: 7 }, (_, k) => ln.get(addDays(day, -k))!))!;
    const base = Array.from({ length: 60 }, (_, k) => m7(addDays(END, -(k + 1))));
    const hrv = factor(d, 'hrv');
    expect(hrv.baselineDays).toBe(60);
    expect(hrv.value).toBe(r1(Math.exp(m7(END))));
    expect(hrv.range!.mean).toBe(r1(Math.exp(mean(base)!)));
    expect(hrv.range!.low).toBe(r1(Math.exp(mean(base)! - stdev(base)!)));
    expect(hrv.range!.high).toBe(r1(Math.exp(mean(base)! + stdev(base)!)));
    expect(hrv.detail.today).toBe(r1(input.hrv.at(-1)!.value));

    // sleep: the night that ended on the day against the 60 nights before
    const sleep = factor(d, 'sleep');
    expect(sleep.valueDay).toBe(END);
    expect(sleep.baselineDays).toBe(60);
    expect(sleep.detail.goalS).toBe(8 * 3600);
  });

  it('scores 50 + points: signals at their baseline add nothing, missing ones are left out and the rest re-weighted', () => {
    // constant signals: every z is 0 (SD floors), no workouts at all
    const d = createReadinessModel(athlete({ constant: true, load: null })).day(END);
    const load = factor(d, 'load');
    expect(load).toMatchObject({ used: false, missing: 'never', points: null });
    const used = d.factors.filter((f) => f.used);
    expect(used.map((f) => f.key)).toEqual(['hrv', 'restingHr', 'sleep', 'sleepTiming', 'respiratoryRate', 'wristTemp', 'spo2']);
    const total = 100 - READINESS_WEIGHTS.load;
    expect(d.coverage).toBe(total / 100);
    for (const f of used) expect(f.z).toBe(0);
    // only the regular sleep timing adds a small bonus: 50 · (5 / 85) · 0.5
    expect(factor(d, 'sleepTiming').points).toBe(r1((50 * 5 * 0.5) / total));
    expect(d.rawScore).toBe(Math.round(50 + (50 * 5 * 0.5) / total));
    expect(d.score).toBe(51);
    expect(d.band).toBe('normal');
    expect(d.reasons).toEqual(['allNormal']);
    // points (rounded to 0.1) add up to the score (rounded to 1)
    expect(Math.abs(50 + used.reduce((s, f) => s + f.points!, 0) - d.rawScore!)).toBeLessThan(1);
  });

  it('drops the score into "recover" when HRV, resting heart rate and sleep all point to strain', () => {
    const hrvLast = Object.fromEntries(Array.from({ length: 7 }, (_, k) => [-k, 33]));
    const d = createReadinessModel(athlete({ hrvLast, rhrLast: { 0: 60 }, nightLast: { asleepS: 4.5 * 3600 } })).day(END);
    expect(factor(d, 'hrv')).toMatchObject({ used: true, effect: -1, reason: 'hrv.low' });
    expect(factor(d, 'restingHr')).toMatchObject({ effect: -1, reason: 'restingHr.high' });
    expect(factor(d, 'sleep')).toMatchObject({ effect: -1, reason: 'sleep.short' });
    expect(d.score).toBeLessThan(20);
    expect(d.band).toBe('recover');
    expect(d.cappedBy).toBeNull(); // the cap only limits higher scores
    // biggest contributions first
    expect(d.reasons.slice(0, 3)).toEqual(['hrv.low', 'restingHr.high', 'sleep.short']);
  });

  it('shows "ready" when HRV is up, resting heart rate down and sleep long', () => {
    const hrvLast = Object.fromEntries(Array.from({ length: 7 }, (_, k) => [-k, 62]));
    const d = createReadinessModel(athlete({ hrvLast, rhrLast: { 0: 48 }, nightLast: { asleepS: 8.6 * 3600 } })).day(END);
    expect(factor(d, 'hrv').reason).toBe('hrv.high');
    expect(factor(d, 'restingHr').reason).toBe('restingHr.low');
    expect(d.score).toBeGreaterThanOrEqual(65);
    expect(d.band).toBe('ready');
    expect(d.reasons).toContain('hrv.high');
  });

  it('caps the score at the top of "take it easy" when one key signal shows a strong warning', () => {
    const hrvLast = Object.fromEntries(Array.from({ length: 7 }, (_, k) => [-k, 60]));
    const d = createReadinessModel(athlete({ hrvLast, nightLast: { wristTemp: 37.2 } })).day(END);
    expect(factor(d, 'wristTemp')).toMatchObject({ effect: -1, reason: 'wristTemp.high' });
    expect(d.rawScore).toBeGreaterThan(CAP);
    expect(d.score).toBe(CAP);
    expect(d.band).toBe('easy');
    expect(d.cappedBy).toBe('wristTemp');
    expect(d.reasons[0]).toBe('capped');
    // a cooler wrist does not count at all
    const cool = createReadinessModel(athlete({ nightLast: { wristTemp: 34.8 } })).day(END);
    expect(factor(cool, 'wristTemp')).toMatchObject({ effect: 0, reason: 'wristTemp.normal' });
    expect(cool.cappedBy).toBeNull();
  });

  it('flags an unusual sleep time as irregular', () => {
    const d = createReadinessModel(athlete({ nightLast: { midpointMin: 190 + 150 } })).day(END);
    const timing = factor(d, 'sleepTiming');
    expect(timing).toMatchObject({ effect: -1, reason: 'sleepTiming.late' });
    expect(timing.detail.shiftMin).toBeGreaterThan(120);
    expect(d.reasons).toContain('sleepTiming.late');
  });

  it('needs 14 baseline days before a signal counts and explains what is missing', () => {
    const d = createReadinessModel(athlete({ days: 10 })).day(END);
    expect(d.score).toBeNull();
    expect(d.band).toBeNull();
    expect(d.insufficient).toBe('noCore');
    expect(d.coverage).toBe(0);
    expect(d.reasons).toEqual([]);
    expect(factor(d, 'restingHr')).toMatchObject({ used: false, missing: 'baseline', baselineDays: 9 });
    expect(factor(d, 'hrv')).toMatchObject({ missing: 'baseline' });
    expect(factor(d, 'load')).toMatchObject({ missing: 'baseline', baselineDays: 9 });
    expect(d.factors.every((f) => !f.used && f.points === null)).toBe(true);

    // with 15 days the resting heart rate (14 baseline days) is enough together with sleep
    const later = createReadinessModel(athlete({ days: 15 })).day(END);
    expect(factor(later, 'restingHr')).toMatchObject({ used: true, baselineDays: 14 });
    expect(later.score).not.toBeNull();
  });

  it('needs HRV or resting heart rate plus a second signal', () => {
    const only = athlete({ load: null });
    const d = createReadinessModel({ ...only, hrv: [], nights: [] }).day(END);
    expect(factor(d, 'restingHr')).toMatchObject({ missing: null, used: false });
    expect(factor(d, 'hrv').missing).toBe('never');
    expect(factor(d, 'sleep').missing).toBe('never');
    expect(d.insufficient).toBe('tooFew');
    expect(d.score).toBeNull();

    const noCore = createReadinessModel({ ...athlete(), hrv: [], restingHr: [] }).day(END);
    expect(noCore.insufficient).toBe('noCore');
  });

  it('falls back to the resting heart rate of the day before (it is written during the day)', () => {
    const input = athlete({ rhrLast: { 0: null } });
    const d = createReadinessModel(input).day(END);
    const rhr = factor(d, 'restingHr');
    expect(rhr.valueDay).toBe(addDays(END, -1));
    expect(rhr.value).toBe(r1(input.restingHr.at(-1)!.value));
    expect(rhr.used).toBe(true);
    // two days without a value: nothing to compare
    const gap = createReadinessModel(athlete({ rhrLast: { 0: null, [-1]: null } })).day(END);
    expect(factor(gap, 'restingHr')).toMatchObject({ missing: 'noValue', valueDay: null });
  });

  it('judges training load as fatigue ÷ fitness at the end of the day before', () => {
    // steady training, then a hard block in the last 6 days (4× the usual load)
    const block = createReadinessModel(athlete({ days: 120, load: (i, n) => (i >= n - 7 && i < n - 1 ? 240 : i % 2 === 0 ? 80 : 0) })).day(END);
    const load = factor(block, 'load');
    expect(load.valueDay).toBe(addDays(END, -1));
    expect(load.value!).toBeGreaterThan(1.3);
    expect(load).toMatchObject({ used: true, reason: 'load.high' });
    expect(load.effect!).toBeLessThan(-0.5);
    expect(load.detail.yesterday).toBe(240);
    expect(load.detail.hardDay).toBe(1);
    expect(block.reasons).toContain('load.high');
    expect(block.reasons).toContain('load.hardDay');
    expect(load.detail.tsb).toBeCloseTo(load.detail.ctl! - load.detail.atl!, 0);

    // four rest days (before the day itself) after steady daily training: fresh
    const rest = createReadinessModel(athlete({ days: 120, load: (i, n) => (i < n - 5 ? 60 : 0) })).day(END);
    expect(factor(rest, 'load')).toMatchObject({ reason: 'load.fresh' });
    expect(factor(rest, 'load').effect!).toBeGreaterThan(0.3);

    // a training history shorter than 28 days is not judged yet
    const fresh = createReadinessModel(athlete({ load: (i, n) => (i >= n - 10 ? 60 : 0) })).day(END);
    expect(factor(fresh, 'load')).toMatchObject({ missing: 'baseline', baselineDays: 9 });

    // stopped training long ago: no recent load to judge
    const stopped = createReadinessModel(athlete({ days: 400, load: (i) => (i < 200 && i % 2 === 0 ? 80 : 0) })).day(END);
    expect(factor(stopped, 'load')).toMatchObject({ missing: 'noValue', used: false });
  });

  it('returns a trend with the HRV and resting heart rate bands of each day', () => {
    const input = athlete();
    const model = createReadinessModel(input);
    const trend = model.trend(addDays(END, -29), END);
    expect(trend).toHaveLength(30);
    expect(trend[0]!.day).toBe(addDays(END, -29));
    expect(trend.at(-1)!.day).toBe(END);
    const last = trend.at(-1)!;
    const d = model.day(END);
    expect(last.score).toBe(d.score);
    expect(last.used).toBe(d.factors.filter((f) => f.used).length);
    expect(last.hrv7).toBe(factor(d, 'hrv').value);
    expect(last.hrvRange).toEqual(factor(d, 'hrv').range);
    expect(last.restingHr).toBe(factor(d, 'restingHr').value);
    expect(last.restingHrRange).toEqual(factor(d, 'restingHr').range);
    // the first 14 days of a fresh athlete have no score yet
    const early = createReadinessModel(athlete({ days: 30 })).trend(addDays(END, -29), END);
    expect(early.slice(0, 14).every((t) => t.score === null)).toBe(true);
    expect(early.at(-1)!.score).not.toBeNull();
  });
});

describe('night samples', () => {
  it('assigns spot readings and the overnight wrist temperature to the night they were recorded in', () => {
    const nights = [
      { bed_ts: 1000, wake_ts: 2000 },
      { bed_ts: 5000, wake_ts: 6000 },
    ];
    const samples = [
      { start_ts: 900, end_ts: 950, value: 99 }, // before bed
      { start_ts: 1100, end_ts: 1160, value: 14 },
      { start_ts: 1900, end_ts: 1960, value: 16 },
      { start_ts: 3000, end_ts: 3060, value: 99 }, // daytime
      { start_ts: 5500, end_ts: 5560, value: 13 },
    ];
    expect(nightMeans(samples, nights, 0)).toEqual([15, 13]);
    // one sample spanning the night that starts a little before bed
    expect(nightMeans([{ start_ts: 4800, end_ts: 6000, value: 36.1 }], nights, 3600)).toEqual([null, 36.1]);
    expect(nightMeans([], nights, 0)).toEqual([null, null]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------------------------

const HRV = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN';
const RHR = 'HKQuantityTypeIdentifierRestingHeartRate';
const LAST = '2026-06-30';

let fx: HealthFixture;
let empty: HealthFixture;

beforeAll(async () => {
  fx = await createHealthFixture();
  empty = await createHealthFixture();
  const resp = fx.addType(1, 'HKQuantityTypeIdentifierRespiratoryRate', 'quantity', 'count/min', 'avg');
  const wrist = fx.addType(2, 'HKQuantityTypeIdentifierAppleSleepingWristTemperature', 'quantity', 'degC', 'avg');
  const spo2 = fx.addType(3, 'HKQuantityTypeIdentifierOxygenSaturation', 'quantity', '%', 'avg');
  fx.addType(4, HRV, 'quantity', 'ms', 'avg');
  fx.addType(5, RHR, 'quantity', 'count/min', 'avg');
  const z = rng(5);
  for (const day of daysEndingAt(80, LAST)) {
    const prev = addDays(day, -1);
    fx.daily(HRV, day, 48 * Math.exp(0.1 * z()));
    fx.daily(RHR, day, Math.round(53 + 1.5 * z()));
    // night from 23:00 to 06:30 (+01:00), attributed to the day of waking up
    run(
      fx.db,
      `INSERT INTO health_sleep_nights (athlete_id, day, kind, bed_ts, wake_ts, tz_bed_min, tz_wake_min, in_bed_s, asleep_s, efficiency)
       VALUES (1, ?, 'night', ?, ?, 60, 60, 27000, ?, 0.93)`,
      [day, ts(`${prev}T23:00:00+01:00`), ts(`${day}T06:30:00+01:00`), Math.round(25_200 + 1200 * z())],
    );
    fx.rec(resp, `${day}T02:00:00+01:00`, `${day}T02:01:00+01:00`, { value: 14 + 0.3 * z() });
    fx.rec(resp, `${day}T04:00:00+01:00`, `${day}T04:01:00+01:00`, { value: 14 + 0.3 * z() });
    fx.rec(spo2, `${day}T03:00:00+01:00`, `${day}T03:00:00+01:00`, { value: 0.96 + 0.004 * z() });
    fx.rec(wrist, `${prev}T23:20:00+01:00`, `${day}T06:30:00+01:00`, { value: 36 + 0.1 * z() });
    // a run every second day (daily_activity is the derived workout total the load model reads)
    if (day.endsWith('0') || day.endsWith('2') || day.endsWith('4') || day.endsWith('6') || day.endsWith('8')) {
      run(
        fx.db,
        `INSERT INTO daily_activity (athlete_id, day, sport, count, duration_s, moving_s, distance_m, elevation_m, energy_kcal, effort)
         VALUES (1, ?, 'run', 1, 3600, 3500, 10000, 50, 700, 90)`,
        [day],
      );
    }
  }
  fx.refreshStats();
}, 60_000);

afterAll(async () => {
  await fx?.close();
  await empty?.close();
});

describe('GET /api/health/readiness', () => {
  it('evaluates the latest data day by default with all signals and a 90-day history', async () => {
    const r = await fx.getJson<ReadinessResponse>('/api/health/readiness');
    expect(r.asOf).toBe(LAST);
    expect(r.day).toBe(LAST);
    const c = r.current!;
    expect(c.day).toBe(LAST);
    expect(c.score).not.toBeNull();
    expect(c.factors.map((f) => f.key)).toEqual(['hrv', 'restingHr', 'sleep', 'sleepTiming', 'load', 'respiratoryRate', 'wristTemp', 'spo2']);
    expect(c.factors.filter((f) => f.used).map((f) => f.key)).toEqual([
      'hrv',
      'restingHr',
      'sleep',
      'sleepTiming',
      'load',
      'respiratoryRate',
      'wristTemp',
      'spo2',
    ]);
    expect(c.coverage).toBe(1);
    // the overnight readings were assigned to the night: 14 /min ± noise, 36 °C, 96 %
    expect(c.factors.find((f) => f.key === 'respiratoryRate')!.value).toBeCloseTo(14, 0);
    expect(c.factors.find((f) => f.key === 'wristTemp')!.value).toBeCloseTo(36, 0);
    expect(c.factors.find((f) => f.key === 'spo2')!.value).toBeCloseTo(0.96, 1);
    // midpoint of 23:00–06:30 = 02:45 → 165 minutes after midnight
    expect(c.factors.find((f) => f.key === 'sleepTiming')!.value).toBe(165);
    expect(r.history).toHaveLength(90);
    expect(r.history.at(-1)!.day).toBe(LAST);
    expect(r.history.at(-1)!.score).toBe(c.score);
    expect(r.history[0]!.score).toBeNull(); // before the data started
    expect(r.model).toMatchObject({ baselineDays: 60, minBaselineDays: 14, hrvDays: 7, cap: 34 });
    expect(Object.values(r.model.weights).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('evaluates any day and history length', async () => {
    const day = addDays(LAST, -10);
    const r = await fx.getJson<ReadinessResponse>(`/api/health/readiness?day=${day}&days=30`);
    expect(r.day).toBe(day);
    expect(r.current!.day).toBe(day);
    expect(r.history).toHaveLength(30);
    expect(r.history.at(-1)!.day).toBe(day);
    const none = await fx.getJson<ReadinessResponse>(`/api/health/readiness?days=0`);
    expect(none.history).toEqual([]);
    expect(none.current!.score).not.toBeNull();
    // a day before any data: explained, no score
    const early = await fx.getJson<ReadinessResponse>(`/api/health/readiness?day=2025-01-01&days=0`);
    expect(early.current!.score).toBeNull();
    expect(early.current!.insufficient).toBe('noCore');
    expect(early.current!.factors.find((f) => f.key === 'hrv')!.missing).toBe('noValue');
  });

  it('validates the query', async () => {
    for (const q of ['day=2026-02-30', 'day=yesterday', 'days=366', 'days=-1', 'days=abc']) {
      const res = await fx.app.inject({ url: `/api/health/readiness?${q}` });
      expect(res.statusCode, q).toBe(400);
    }
  });

  it('returns an empty answer without health data', async () => {
    const r = await empty.getJson<ReadinessResponse>('/api/health/readiness');
    expect(r).toMatchObject({ asOf: null, day: null, current: null, history: [] });
    expect(r.model.bands.map((b) => b.key)).toEqual(['ready', 'normal', 'easy', 'recover']);
  });
});
