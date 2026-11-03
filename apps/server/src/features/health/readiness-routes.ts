import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { midnightOffsetMin, type DayValue, type ReadinessResponse } from '@cadence/shared';
import { all, get, type Db } from '../../db/db';
import { addDays, parseDay } from '../../lib/time';
import { BASELINE_DAYS, HRV_DAYS, createReadinessModel, readinessModelInfo, type ReadinessInput, type ReadinessNight } from './readiness';
import { dataRange, dayParam, getHealthSettings, typeIdByIdentifier } from './util';

const HRV = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN';
const RHR = 'HKQuantityTypeIdentifierRestingHeartRate';
const RESP = 'HKQuantityTypeIdentifierRespiratoryRate';
const WRIST = 'HKQuantityTypeIdentifierAppleSleepingWristTemperature';
const SPO2 = 'HKQuantityTypeIdentifierOxygenSaturation';

/** Plausible values (canonical units); anything outside is a measurement error. */
const PLAUSIBLE = {
  hrv: [3, 300],
  rhr: [25, 140],
  resp: [4, 40],
  wrist: [30, 42],
  spo2: [0.7, 1],
} as const;

const readinessQuery = z.object({
  day: dayParam.refine((d) => parseDay(d) !== null, 'not a calendar day').optional(),
  days: z.coerce.number().int().min(0).max(365).default(90),
});

interface NightRow {
  day: string;
  bed_ts: number;
  wake_ts: number;
  tz_wake_min: number;
  asleep_s: number;
  in_bed_s: number;
  efficiency: number | null;
}

interface SampleRow {
  start_ts: number;
  end_ts: number;
  value: number;
}

const exists = (db: Db, sql: string, params: (string | number)[]): boolean => get(db, `${sql} LIMIT 1`, params) !== undefined;

function dailyValues(db: Db, athleteId: number, metric: string, from: string, to: string, [lo, hi]: readonly [number, number]): DayValue[] {
  return all<DayValue>(
    db,
    `SELECT day, value FROM daily_metrics
     WHERE athlete_id = ? AND metric = ? AND day >= ? AND day <= ? AND value BETWEEN ? AND ? ORDER BY day`,
    [athleteId, metric, from, to, lo, hi],
  );
}

/**
 * Mean of the samples recorded during each night (nights sorted by bedtime). A sample belongs to a night when it
 * starts before waking up, ends after going to bed and starts at most `leadS` before bedtime – the sleeping wrist
 * temperature is one sample spanning the night, respiratory rate and SpO₂ are spot readings.
 */
export function nightMeans(samples: SampleRow[], nights: { bed_ts: number; wake_ts: number }[], leadS: number): (number | null)[] {
  const out: (number | null)[] = [];
  let lo = 0;
  for (const n of nights) {
    while (lo < samples.length && samples[lo]!.start_ts < n.bed_ts - leadS) lo++;
    let sum = 0;
    let count = 0;
    for (let i = lo; i < samples.length && samples[i]!.start_ts <= n.wake_ts; i++) {
      const s = samples[i]!;
      if (s.end_ts >= n.bed_ts) {
        sum += s.value;
        count++;
      }
    }
    out.push(count ? sum / count : null);
  }
  return out;
}

/** Everything the model needs to evaluate the days fromDay … toDay (baselines reach 60 + 7 days further back). */
export function loadReadinessInput(db: Db, athleteId: number, fromDay: string, toDay: string): ReadinessInput {
  const lo = addDays(fromDay, -(BASELINE_DAYS + HRV_DAYS + 1));
  const nightRows = all<NightRow>(
    db,
    `SELECT day, bed_ts, wake_ts, tz_wake_min, asleep_s, in_bed_s, efficiency FROM health_sleep_nights
     WHERE athlete_id = ? AND kind = 'night' AND asleep_s > 0 AND day >= ? AND day <= ? ORDER BY bed_ts`,
    [athleteId, lo, toDay],
  );

  const present: ReadinessInput['present'] = {
    hrv: exists(db, 'SELECT 1 FROM daily_metrics WHERE athlete_id = ? AND metric = ?', [athleteId, HRV]),
    restingHr: exists(db, 'SELECT 1 FROM daily_metrics WHERE athlete_id = ? AND metric = ?', [athleteId, RHR]),
    sleep: exists(db, `SELECT 1 FROM health_sleep_nights WHERE athlete_id = ? AND kind = 'night' AND asleep_s > 0`, [athleteId]),
    load: exists(db, 'SELECT 1 FROM daily_activity WHERE athlete_id = ?', [athleteId]),
  };

  const perNight = (identifier: string, key: 'respiratoryRate' | 'wristTemp' | 'spo2', range: readonly [number, number], leadS: number) => {
    const typeId = typeIdByIdentifier(db, identifier);
    present[key] = typeId !== null && exists(db, 'SELECT 1 FROM records WHERE athlete_id = ? AND type_id = ?', [athleteId, typeId]);
    if (!present[key] || !nightRows.length) return nightRows.map(() => null);
    const samples = all<SampleRow>(
      db,
      `SELECT start_ts, end_ts, value FROM records
       WHERE athlete_id = ? AND type_id = ? AND start_ts >= ? AND start_ts <= ? AND value BETWEEN ? AND ?
       ORDER BY start_ts`,
      [athleteId, typeId!, nightRows[0]!.bed_ts - leadS, nightRows[nightRows.length - 1]!.wake_ts, range[0], range[1]],
    );
    return nightMeans(samples, nightRows, leadS);
  };
  const resp = perNight(RESP, 'respiratoryRate', PLAUSIBLE.resp, 0);
  const wrist = perNight(WRIST, 'wristTemp', PLAUSIBLE.wrist, 12 * 3600);
  const spo2 = perNight(SPO2, 'spo2', PLAUSIBLE.spo2, 0);

  const nights: ReadinessNight[] = nightRows.map((n, i) => ({
    day: n.day,
    asleepS: n.asleep_s,
    inBedS: n.in_bed_s,
    efficiency: n.efficiency,
    midpointMin: midnightOffsetMin((n.bed_ts + n.wake_ts) / 2, n.tz_wake_min),
    respiratoryRate: resp[i]!,
    wristTemp: wrist[i]!,
    spo2: spo2[i]!,
  }));

  return {
    hrv: dailyValues(db, athleteId, HRV, lo, toDay, PLAUSIBLE.hrv),
    restingHr: dailyValues(db, athleteId, RHR, lo, toDay, PLAUSIBLE.rhr),
    nights,
    // the fitness / fatigue model needs the whole training history (hidden and duplicate workouts are excluded there)
    loads: all<DayValue>(
      db,
      'SELECT day, SUM(effort) AS value FROM daily_activity WHERE athlete_id = ? AND day <= ? GROUP BY day ORDER BY day',
      [athleteId, toDay],
    ),
    present,
    sleepGoalS: getHealthSettings(db, athleteId).sleepGoalMin * 60,
  };
}

export function buildReadiness(db: Db, athleteId: number, q: { day?: string; days: number }): ReadinessResponse {
  const { asOf } = dataRange(db, athleteId);
  const day = q.day ?? asOf;
  if (!asOf || !day) return { asOf, day: null, current: null, history: [], model: readinessModelInfo() };
  const fromDay = q.days > 0 ? addDays(day, -(q.days - 1)) : day;
  const model = createReadinessModel(loadReadinessInput(db, athleteId, fromDay, day));
  return {
    asOf,
    day,
    current: model.day(day),
    history: q.days > 0 ? model.trend(fromDay, day) : [],
    model: readinessModelInfo(),
  };
}

export function registerReadinessRoutes(app: FastifyInstance): void {
  // Readiness of a day (default: the latest day with data) with its factors, plus the score history for the trend
  app.get('/readiness', async (req): Promise<ReadinessResponse> => {
    const q = readinessQuery.parse(req.query);
    return buildReadiness(app.db, req.athleteId, q);
  });
}
