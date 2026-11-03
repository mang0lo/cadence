/**
 * Daily readiness – "how recovered am I today?" – from personal baselines instead of population norms.
 * Pure functions, no database access (data loading: readiness-routes.ts; tests: test/health-readiness.test.ts).
 *
 * Signals of a local day D (see docs/ARCHITECTURE.md for days):
 *  - hrv           mean of ln(SDNN) over D−6 … D (daily means, ≥ 3 days with a reading) against the same 7-day means
 *                  of the 60 days before D (mean ± SD = the normal range);
 *  - restingHr     resting heart rate of D (else of D−1) against the 60 days before it;
 *  - sleep         time asleep in the night that ended on D against the 60 nights before;
 *  - sleepTiming   midpoint of that night against the usual midpoint (regularity);
 *  - load          fatigue ÷ fitness (ATL / CTL of the daily relative effort, the progress feature's model) at the end
 *                  of D−1 – today's training has not happened yet when the estimate is read in the morning;
 *  - respiratoryRate, wristTemp, spo2   means during that night against the nights before; only a rise (SpO₂: a
 *                  drop) counts, being lower (higher) than usual is no sign of better recovery.
 * A signal counts once its baseline window has ≥ 14 days (nights) of data. Its deviation z (in baseline SDs) becomes an
 * effect −1 … +1: ±0.5 at the edge of the normal range, ±1 at twice that. The score is
 *   50 + 50 · Σ shareᵢ · effectᵢ,   shareᵢ = weightᵢ / Σ weights of the signals used,
 * so 50 means "everything exactly as usual" and every signal's points are additive. Conservative rules: no score
 * without HRV or resting heart rate plus a second signal, and one strong warning in a key signal (HRV, resting heart
 * rate, respiratory rate, wrist temperature) limits the score to the top of the 'easy' band.
 */
import {
  READINESS_FACTORS,
  dayFromNumber,
  dayNumber,
  mean,
  stdev,
  type DayValue,
  type ReadinessBand,
  type ReadinessDay,
  type ReadinessFactor,
  type ReadinessFactorKey,
  type ReadinessModelInfo,
  type ReadinessRange,
  type ReadinessTrendDay,
} from '@cadence/shared';
import { ATL_DAYS, CTL_DAYS, trainingLoad, type LoadDay } from '../progress/math';

// ---------------------------------------------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------------------------------------------

/** Personal baseline: the days before the evaluated day … */
export const BASELINE_DAYS = 60;
/** … of which at least this many need data before a signal counts. */
export const MIN_BASELINE_DAYS = 14;
/** HRV: mean of ln(SDNN) over this many days, with at least HRV_MIN_DAYS readings. */
export const HRV_DAYS = 7;
export const HRV_MIN_DAYS = 3;

/** Nominal weights (sum 100); signals without data are left out and the others re-weighted. */
export const READINESS_WEIGHTS: Record<ReadinessFactorKey, number> = {
  hrv: 30,
  restingHr: 20,
  sleep: 20,
  sleepTiming: 5,
  load: 15,
  respiratoryRate: 4,
  wristTemp: 4,
  spo2: 2,
};

/** Bands, best first. */
export const READINESS_BANDS: { key: ReadinessBand; min: number }[] = [
  { key: 'ready', min: 65 },
  { key: 'normal', min: 35 },
  { key: 'easy', min: 20 },
  { key: 'recover', min: 0 },
];

/** A key signal with an effect at or below CAP_EFFECT limits the score to CAP (top of the 'easy' band). */
export const CAP = 34;
export const CAP_EFFECT = -0.9;
const CAP_FACTORS: ReadinessFactorKey[] = ['hrv', 'restingHr', 'respiratoryRate', 'wristTemp'];

/** Fatigue ÷ fitness inside this range is balanced; the edges give an effect of ∓0.5 like a normal-range edge. */
export const LOAD_RANGE = { low: 0.7, high: 1.3 };
/** Training history (days since the first workout) before the load signal counts. */
export const MIN_LOAD_DAYS = 28;
/** Below this fitness (CTL) there is no recent training to judge. */
const MIN_CTL = 5;
/** A day counts as hard when its load reaches this quantile of the active days of the last 90 days (≥ 8 of them). */
const HARD_QUANTILE = 0.8;
const HARD_WINDOW = 90;
const HARD_MIN_DAYS = 8;

type BaselineKey = Exclude<ReadinessFactorKey, 'load'>;

/**
 * Smallest standard deviation used for z (canonical units): measurement resolution, so a very steady baseline does not
 * turn tiny changes into big effects. HRV on the ln scale (0.03 ≈ 3 %), sleep in seconds, sleep timing in minutes.
 */
const SD_FLOOR: Record<BaselineKey, number> = {
  hrv: 0.03,
  restingHr: 1,
  sleep: 20 * 60,
  sleepTiming: 20,
  respiratoryRate: 0.3,
  wristTemp: 0.1,
  spo2: 0.005,
};

/** Fraction digits of values and ranges in the response. */
const DIGITS: Record<ReadinessFactorKey, number> = {
  hrv: 1,
  restingHr: 1,
  sleep: 0,
  sleepTiming: 0,
  load: 2,
  respiratoryRate: 2,
  wristTemp: 2,
  spo2: 3,
};

export function readinessBand(score: number): ReadinessBand {
  for (const b of READINESS_BANDS) if (score >= b.min) return b.key;
  return 'recover';
}

export function readinessModelInfo(): ReadinessModelInfo {
  return {
    baselineDays: BASELINE_DAYS,
    minBaselineDays: MIN_BASELINE_DAYS,
    hrvDays: HRV_DAYS,
    weights: { ...READINESS_WEIGHTS },
    bands: READINESS_BANDS.map((b) => ({ ...b })),
    cap: CAP,
    loadRange: { ...LOAD_RANGE },
    atlDays: ATL_DAYS,
    ctlDays: CTL_DAYS,
    minLoadDays: MIN_LOAD_DAYS,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------------------------

export interface ReadinessNight {
  /** Local day of waking up. */
  day: string;
  asleepS: number;
  inBedS?: number;
  efficiency?: number | null;
  /** Midpoint of the night in minutes from local midnight (negative = before midnight). */
  /** null when the night's times are unknown (device clouds that report totals only). */
  midpointMin: number | null;
  /** Means of the samples recorded during the night (null = none). */
  respiratoryRate?: number | null;
  wristTemp?: number | null;
  spo2?: number | null;
}

export interface ReadinessInput {
  /** Daily mean SDNN (ms) per local day, plausible values only. */
  hrv: DayValue[];
  /** Resting heart rate (bpm) per local day. */
  restingHr: DayValue[];
  /** Main sleep of each wake-up day (naps excluded); nights without time asleep are ignored. */
  nights: ReadinessNight[];
  /** Relative effort per local day (days without workouts may be left out). Must reach back to the first workout. */
  loads: DayValue[];
  /**
   * Signals that exist anywhere in the athlete's data – tells "not in your export" ('never') from "nothing for this day"
   * ('noValue'). Keys left out are derived from the input.
   */
  present?: Partial<Record<ReadinessFactorKey, boolean>>;
  /** Sleep goal in seconds (shown next to the sleep signal). */
  sleepGoalS?: number;
}

export interface ReadinessModel {
  /** Score, band, factors and reasons of one day. */
  day(day: string): ReadinessDay;
  /** One entry per day from `fromDay` to `toDay` (inclusive). */
  trend(fromDay: string, toDay: string): ReadinessTrendDay[];
}

// ---------------------------------------------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r; // no "-0"
}

const roundRange = (r: ReadinessRange, digits: number): ReadinessRange => ({
  mean: round(r.mean, digits),
  low: round(r.low, digits),
  high: round(r.high, digits),
});

interface Stats {
  mean: number;
  /** Floored standard deviation. */
  sd: number;
}

function baselineStats(values: number[], floor: number): Stats | null {
  if (values.length < MIN_BASELINE_DAYS) return null;
  return { mean: mean(values)!, sd: Math.max(stdev(values) ?? 0, floor) };
}

/** Effect of a deviation z (in baseline SDs) on recovery: + = better recovered. */
export function effectOf(key: BaselineKey, z: number): number {
  switch (key) {
    case 'hrv':
      return clamp(z / 2, -1, 1);
    case 'restingHr':
      return clamp(-z / 2, -1, 1);
    case 'sleep':
      // much more sleep than usual is not proportionally better (and can come with illness)
      return clamp(z / 2, -1, 0.5);
    case 'sleepTiming':
      // regular = small bonus; outside the normal range (either way) counts against recovery
      return clamp(0.5 - Math.abs(z) / 2, -1, 0.5);
    case 'respiratoryRate':
    case 'wristTemp':
      return clamp(-z / 2, -1, 0);
    case 'spo2':
      return clamp(z / 2, -1, 0);
  }
}

/** Reason code of a baseline signal and whether it is notable (outside the normal range in a direction that matters). */
function reasonOf(key: BaselineKey, z: number): { reason: string; notable: boolean } {
  const hi = z >= 1;
  const lo = z <= -1;
  switch (key) {
    case 'hrv':
      return { reason: lo ? 'hrv.low' : hi ? 'hrv.high' : 'hrv.normal', notable: lo || hi };
    case 'restingHr':
      return { reason: hi ? 'restingHr.high' : lo ? 'restingHr.low' : 'restingHr.normal', notable: lo || hi };
    case 'sleep':
      return { reason: lo ? 'sleep.short' : hi ? 'sleep.long' : 'sleep.normal', notable: lo || hi };
    case 'sleepTiming':
      return {
        reason: z > 1 ? 'sleepTiming.late' : z < -1 ? 'sleepTiming.early' : 'sleepTiming.regular',
        notable: Math.abs(z) > 1,
      };
    case 'respiratoryRate':
      return { reason: hi ? 'respiratoryRate.high' : 'respiratoryRate.normal', notable: hi };
    case 'wristTemp':
      return { reason: hi ? 'wristTemp.high' : 'wristTemp.normal', notable: hi };
    case 'spo2':
      return { reason: lo ? 'spo2.low' : 'spo2.normal', notable: lo };
  }
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const a = Math.floor(pos);
  const b = Math.ceil(pos);
  return sorted[a]! + (sorted[b]! - sorted[a]!) * (pos - a);
}

interface FactorState extends ReadinessFactor {
  notable: boolean;
}

function blank(key: ReadinessFactorKey): FactorState {
  return {
    key,
    used: false,
    missing: null,
    weight: READINESS_WEIGHTS[key],
    valueDay: null,
    value: null,
    range: null,
    baselineDays: 0,
    z: null,
    effect: null,
    points: null,
    reason: null,
    detail: {},
    notable: false,
  };
}

const NIGHT_METRICS = ['respiratoryRate', 'wristTemp', 'spo2'] as const;

export function createReadinessModel(input: ReadinessInput): ReadinessModel {
  const byDay = (points: DayValue[]) => new Map(points.map((p) => [dayNumber(p.day), p.value]));
  const hrv = byDay(input.hrv.filter((p) => p.value > 0));
  const lnHrv = new Map([...hrv].map(([d, v]) => [d, Math.log(v)]));
  const rhr = byDay(input.restingHr);
  const nights = new Map(input.nights.filter((n) => n.asleepS > 0).map((n) => [dayNumber(n.day), n]));
  const loadByDay = byDay(input.loads);

  const anyNight = (f: (n: ReadinessNight) => unknown) => [...nights.values()].some((n) => f(n) != null);
  const present: Record<ReadinessFactorKey, boolean> = {
    hrv: input.present?.hrv ?? hrv.size > 0,
    restingHr: input.present?.restingHr ?? rhr.size > 0,
    sleep: input.present?.sleep ?? nights.size > 0,
    sleepTiming: input.present?.sleepTiming ?? input.present?.sleep ?? nights.size > 0,
    load: input.present?.load ?? loadByDay.size > 0,
    respiratoryRate: input.present?.respiratoryRate ?? anyNight((n) => n.respiratoryRate),
    wristTemp: input.present?.wristTemp ?? anyNight((n) => n.wristTemp),
    spo2: input.present?.spo2 ?? anyNight((n) => n.spo2),
  };

  // --- HRV: 7-day means of ln(SDNN), memoised per day number ---
  const m7Cache = new Map<number, number | null>();
  const m7 = (dn: number): number | null => {
    const hit = m7Cache.get(dn);
    if (hit !== undefined) return hit;
    let sum = 0;
    let n = 0;
    for (let k = dn - HRV_DAYS + 1; k <= dn; k++) {
      const v = lnHrv.get(k);
      if (v !== undefined) {
        sum += v;
        n++;
      }
    }
    const out = n >= HRV_MIN_DAYS ? sum / n : null;
    m7Cache.set(dn, out);
    return out;
  };

  /** Values of `get` on the BASELINE_DAYS days before `dn`. */
  const window = (dn: number, get: (k: number) => number | null | undefined): number[] => {
    const out: number[] = [];
    for (let k = dn - BASELINE_DAYS; k < dn; k++) {
      const v = get(k);
      if (v !== null && v !== undefined && Number.isFinite(v)) out.push(v);
    }
    return out;
  };

  /** Common path of the baseline signals: value + window → z, effect, reason, range. */
  const scoreAgainstBaseline = (
    f: FactorState,
    key: BaselineKey,
    value: number | null | undefined,
    base: number[],
    toRange: (s: Stats) => ReadinessRange = (s) => ({ mean: s.mean, low: s.mean - s.sd, high: s.mean + s.sd }),
  ): FactorState => {
    f.baselineDays = base.length;
    const stats = baselineStats(base, SD_FLOOR[key]);
    if (stats) f.range = toRange(stats);
    if (!present[key]) f.missing = 'never';
    else if (value === null || value === undefined) f.missing = 'noValue';
    else if (!stats) f.missing = 'baseline';
    if (value !== null && value !== undefined) f.value = value;
    if (f.missing || !stats || value === null || value === undefined) return f;
    const z = (value - stats.mean) / stats.sd;
    const { reason, notable } = reasonOf(key, z);
    return Object.assign(f, { z, effect: effectOf(key, z), reason, notable });
  };

  const hrvFactor = (dn: number): FactorState => {
    const f = blank('hrv');
    const cur = m7(dn);
    f.valueDay = cur === null ? null : dayFromNumber(dn);
    f.detail = { today: hrv.get(dn) ?? null };
    scoreAgainstBaseline(f, 'hrv', cur, window(dn, m7), (s) => ({
      mean: Math.exp(s.mean),
      low: Math.exp(s.mean - s.sd),
      high: Math.exp(s.mean + s.sd),
    }));
    if (f.value !== null) f.value = Math.exp(f.value); // ln → ms (geometric mean)
    return f;
  };

  const restingHrFactor = (dn: number): FactorState => {
    const f = blank('restingHr');
    // Apple writes the resting heart rate of a day during that day: in the morning only yesterday's may exist
    const vd = rhr.has(dn) ? dn : rhr.has(dn - 1) ? dn - 1 : dn;
    const value = rhr.get(vd);
    if (value !== undefined) f.valueDay = dayFromNumber(vd);
    return scoreAgainstBaseline(f, 'restingHr', value, window(vd, (k) => rhr.get(k)));
  };

  const nightFactor = (dn: number, key: 'sleep' | 'sleepTiming' | (typeof NIGHT_METRICS)[number]): FactorState => {
    const f = blank(key);
    const pick = (n: ReadinessNight | undefined): number | null | undefined =>
      !n ? undefined : key === 'sleep' ? n.asleepS : key === 'sleepTiming' ? n.midpointMin : n[key];
    const night = nights.get(dn);
    const value = pick(night);
    if (value !== null && value !== undefined) f.valueDay = dayFromNumber(dn);
    scoreAgainstBaseline(f, key, value, window(dn, (k) => pick(nights.get(k))));
    if (key === 'sleep') {
      f.detail = {
        goalS: input.sleepGoalS ?? null,
        inBedS: night?.inBedS ?? null,
        efficiency: night?.efficiency ?? null,
      };
    } else if (key === 'sleepTiming' && f.range && f.value !== null) {
      f.detail = { shiftMin: f.value - f.range.mean };
    }
    return f;
  };

  // --- training load: the progress feature's fitness / fatigue model over the daily relative effort ---
  const loadDays = [...loadByDay.keys()].sort((a, b) => a - b);
  const firstLoad = loadDays[0] ?? null;
  const lastLoad = loadDays[loadDays.length - 1] ?? null;
  const loadModel: LoadDay[] =
    firstLoad === null || lastLoad === null
      ? []
      : trainingLoad(Array.from({ length: lastLoad - firstLoad + 1 }, (_, i) => loadByDay.get(firstLoad + i) ?? 0));
  /** Fitness and fatigue at the end of day `dn` (after the last workout both decay without new load). */
  const loadAt = (dn: number): { ctl: number; atl: number } | null => {
    if (firstLoad === null || lastLoad === null || dn < firstLoad) return null;
    if (dn <= lastLoad) return loadModel[dn - firstLoad]!;
    const last = loadModel[loadModel.length - 1]!;
    const k = dn - lastLoad;
    return { ctl: last.ctl * (1 - 1 / CTL_DAYS) ** k, atl: last.atl * (1 - 1 / ATL_DAYS) ** k };
  };

  const loadFactor = (dn: number): { f: FactorState; hardDay: boolean } => {
    const f = blank('load');
    f.range = { mean: 1, low: LOAD_RANGE.low, high: LOAD_RANGE.high };
    const prev = dn - 1;
    if (!present.load) {
      f.missing = 'never';
      return { f, hardDay: false };
    }
    f.baselineDays = firstLoad === null || prev < firstLoad ? 0 : prev - firstLoad + 1;
    const state = loadAt(prev);
    if (!state || f.baselineDays < MIN_LOAD_DAYS) {
      f.missing = 'baseline';
      return { f, hardDay: false };
    }
    const yesterday = loadByDay.get(prev) ?? 0;
    const active: number[] = [];
    for (let k = prev - HARD_WINDOW; k < prev; k++) {
      const v = loadByDay.get(k);
      if (v !== undefined && v > 0) active.push(v);
    }
    active.sort((a, b) => a - b);
    const hardDay = active.length >= HARD_MIN_DAYS && yesterday > 0 && yesterday >= quantile(active, HARD_QUANTILE);
    f.valueDay = dayFromNumber(prev);
    f.detail = {
      ctl: round(state.ctl, 1),
      atl: round(state.atl, 1),
      tsb: round(state.ctl - state.atl, 1),
      yesterday: round(yesterday, 1),
      hardDay: hardDay ? 1 : 0,
    };
    if (state.ctl < MIN_CTL) {
      f.missing = 'noValue'; // no recent training to judge
      return { f, hardDay: false };
    }
    const ratio = state.atl / state.ctl;
    const halfWidth = (LOAD_RANGE.high - LOAD_RANGE.low) / 2;
    const high = ratio > LOAD_RANGE.high;
    const fresh = ratio < LOAD_RANGE.low;
    Object.assign(f, {
      value: ratio,
      effect: clamp((1 - ratio) / (2 * halfWidth), -1, 1),
      reason: high ? 'load.high' : fresh ? 'load.fresh' : 'load.balanced',
      notable: high || fresh,
    });
    return { f, hardDay };
  };

  const evaluate = (dn: number): ReadinessDay => {
    const load = loadFactor(dn);
    const byKey: Record<ReadinessFactorKey, FactorState> = {
      hrv: hrvFactor(dn),
      restingHr: restingHrFactor(dn),
      sleep: nightFactor(dn, 'sleep'),
      sleepTiming: nightFactor(dn, 'sleepTiming'),
      load: load.f,
      respiratoryRate: nightFactor(dn, 'respiratoryRate'),
      wristTemp: nightFactor(dn, 'wristTemp'),
      spo2: nightFactor(dn, 'spo2'),
    };
    const factors = READINESS_FACTORS.map((k) => byKey[k]);
    const available = factors.filter((f) => f.missing === null && f.effect !== null);
    const insufficient: ReadinessDay['insufficient'] = !available.some((f) => f.key === 'hrv' || f.key === 'restingHr')
      ? 'noCore'
      : available.length < 2
        ? 'tooFew'
        : null;
    // without a score nothing is "used"; available signals keep missing = null
    const used = insufficient ? [] : available;
    const totalWeight = used.reduce((s, f) => s + f.weight, 0);

    let score: number | null = null;
    let rawScore: number | null = null;
    let cappedBy: ReadinessFactorKey | null = null;
    const reasons: string[] = [];
    if (!insufficient) {
      let raw = 50;
      for (const f of used) f.used = true;
      for (const f of used) {
        f.points = (50 * f.weight * f.effect!) / totalWeight;
        raw += f.points;
      }
      rawScore = Math.round(clamp(raw, 0, 100));
      score = rawScore;
      const warning = used
        .filter((f) => CAP_FACTORS.includes(f.key) && f.effect! <= CAP_EFFECT)
        .sort((a, b) => a.effect! - b.effect!)[0];
      if (warning && score > CAP) {
        score = CAP;
        cappedBy = warning.key;
      }
      const notable = used.filter((f) => f.notable).sort((a, b) => Math.abs(b.points!) - Math.abs(a.points!));
      if (cappedBy) reasons.push('capped');
      for (const f of notable) reasons.push(f.reason!);
      if (load.hardDay && byKey.load.used) reasons.push('load.hardDay');
      if (!reasons.length) reasons.push('allNormal');
    }

    return {
      day: dayFromNumber(dn),
      score,
      band: score === null ? null : readinessBand(score),
      rawScore,
      cappedBy,
      coverage: round(totalWeight / 100, 2),
      insufficient,
      reasons,
      factors: factors.map(({ notable: _, ...f }) => ({
        ...f,
        value: f.value === null ? null : round(f.value, DIGITS[f.key]),
        range: f.range === null ? null : roundRange(f.range, DIGITS[f.key]),
        z: f.z === null ? null : round(f.z, 2),
        effect: f.effect === null ? null : round(f.effect, 2),
        points: f.points === null ? null : round(f.points, 1),
        detail: Object.fromEntries(
          Object.entries(f.detail).map(([k, v]) => [k, v === null ? null : round(v, k === 'efficiency' ? 3 : 1)]),
        ),
      })),
    };
  };

  return {
    day: (day) => evaluate(dayNumber(day)),
    trend(fromDay, toDay) {
      const out: ReadinessTrendDay[] = [];
      for (let dn = dayNumber(fromDay); dn <= dayNumber(toDay); dn++) {
        const d = evaluate(dn);
        const hrvF = d.factors.find((f) => f.key === 'hrv')!;
        const rhrStats = baselineStats(
          window(dn, (k) => rhr.get(k)),
          SD_FLOOR.restingHr,
        );
        const today = rhr.get(dn);
        const ln7 = m7(dn);
        out.push({
          day: d.day,
          score: d.score,
          band: d.band,
          used: d.factors.filter((f) => f.used).length,
          hrv: hrv.has(dn) ? round(hrv.get(dn)!, 1) : null,
          hrv7: ln7 === null ? null : round(Math.exp(ln7), 1),
          hrvRange: hrvF.range,
          restingHr: today === undefined ? null : round(today, 1),
          restingHrRange: rhrStats
            ? roundRange({ mean: rhrStats.mean, low: rhrStats.mean - rhrStats.sd, high: rhrStats.mean + rhrStats.sd }, 1)
            : null,
        });
      }
      return out;
    },
  };
}
