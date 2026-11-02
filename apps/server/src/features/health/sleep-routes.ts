import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  SLEEP_STAGE_CODES,
  mean,
  type SleepNight,
  type SleepNightDetail,
  type SleepPhysiology,
  type SleepSegment,
  type TimedValue,
} from '@cadence/shared';
import { all, get, type Db } from '../../db/db';
import { notFound } from '../../lib/http';
import { addDays } from '../../lib/time';
import { NIGHT_COLS, toNight, type NightRow } from './sleep';
import { checkDayOrder, dayParam, typeIdByIdentifier } from './util';

const nightsQuery = z.object({
  fromDay: dayParam.optional(),
  toDay: dayParam.optional(),
  kind: z.enum(['night', 'nap', 'all']).default('night'),
});

const nightQuery = z.object({
  day: dayParam.optional(),
  id: z.coerce.number().int().positive().optional(),
});

/** More samples than this are reduced to bucket means so the chart payload stays small. */
const MAX_POINTS = 360;
const BUCKET_S = 300;

function timedSamples(db: Db, athleteId: number, identifier: string, lo: number, hi: number): TimedValue[] {
  const typeId = typeIdByIdentifier(db, identifier);
  if (typeId === null) return [];
  return all<TimedValue>(
    db,
    `SELECT start_ts AS ts, value FROM records
     WHERE athlete_id = ? AND type_id = ? AND start_ts >= ? AND start_ts < ? AND value IS NOT NULL ORDER BY start_ts`,
    [athleteId, typeId, lo, hi],
  );
}

/** Mean per `bucketS` bucket; the point sits in the middle of its bucket. */
export function bucketMeans(points: TimedValue[], bucketS: number): TimedValue[] {
  const out: TimedValue[] = [];
  let key = NaN;
  let sum = 0;
  let n = 0;
  const flush = () => {
    if (n) out.push({ ts: key * bucketS + bucketS / 2, value: sum / n });
  };
  for (const p of points) {
    const k = Math.floor(p.ts / bucketS);
    if (k !== key) {
      flush();
      key = k;
      sum = 0;
      n = 0;
    }
    sum += p.value;
    n++;
  }
  flush();
  return out;
}

const HR = 'HKQuantityTypeIdentifierHeartRate';
const HRV = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN';
const RESP = 'HKQuantityTypeIdentifierRespiratoryRate';
const SPO2 = 'HKQuantityTypeIdentifierOxygenSaturation';
const WRIST = 'HKQuantityTypeIdentifierAppleSleepingWristTemperature';

export function sleepPhysiology(db: Db, athleteId: number, n: SleepNight): SleepPhysiology {
  const lo = n.bedTs;
  const hi = n.wakeTs;
  const hrRaw = timedSamples(db, athleteId, HR, lo, hi);
  const asleepLo = n.onsetTs ?? lo;
  const asleepHi = n.finalTs ?? hi;
  const hrAsleep = hrRaw.filter((p) => p.ts >= asleepLo && p.ts <= asleepHi).map((p) => p.value);
  const hrv = timedSamples(db, athleteId, HRV, lo, hi);
  const resp = timedSamples(db, athleteId, RESP, lo, hi);
  const spo2 = timedSamples(db, athleteId, SPO2, lo, hi);

  let wristTemp: SleepPhysiology['wristTemp'] = null;
  const wristType = typeIdByIdentifier(db, WRIST);
  if (wristType !== null) {
    const w = get<{ value: number }>(
      db,
      `SELECT value FROM records
       WHERE athlete_id = ? AND type_id = ? AND start_ts >= ? AND start_ts <= ? AND end_ts >= ? AND value IS NOT NULL
       ORDER BY ABS(start_ts - ?) LIMIT 1`,
      [athleteId, wristType, lo - 12 * 3600, hi, lo, lo],
    );
    if (w) {
      // baseline: mean of the nights 2..32 days before (the night itself may be keyed to the evening before)
      const b = get<{ v: number | null; n: number }>(
        db,
        `SELECT AVG(value) AS v, COUNT(*) AS n FROM daily_metrics
         WHERE athlete_id = ? AND metric = ? AND day >= ? AND day <= ?`,
        [athleteId, WRIST, addDays(n.day, -32), addDays(n.day, -2)],
      );
      const baseline = b && b.n >= 5 ? b.v : null;
      wristTemp = { value: w.value, baseline, delta: baseline === null ? null : w.value - baseline };
    }
  }

  const reduce = (pts: TimedValue[]) => (pts.length > MAX_POINTS ? bucketMeans(pts, BUCKET_S) : pts);
  return {
    hr: reduce(hrRaw),
    hrMin: hrAsleep.length ? hrAsleep.reduce((a, b) => (b < a ? b : a)) : null,
    hrAvg: mean(hrAsleep),
    hrv,
    hrvAvg: mean(hrv.map((p) => p.value)),
    resp,
    respAvg: mean(resp.map((p) => p.value)),
    spo2,
    spo2Avg: mean(spo2.map((p) => p.value)),
    wristTemp,
  };
}

function segmentsOf(json: string | undefined, bedTs: number): SleepSegment[] {
  let raw: [number, number, number][] = [];
  try {
    raw = JSON.parse(json ?? '[]') as [number, number, number][];
  } catch {
    raw = [];
  }
  return raw.map(([off, dur, code]) => ({
    startTs: bedTs + off,
    endTs: bedTs + off + dur,
    stage: SLEEP_STAGE_CODES[code] ?? 'asleep',
  }));
}

export function registerSleepRoutes(app: FastifyInstance): void {
  // Nights (or naps) in a range of wake-up days, without stage segments
  app.get('/sleep/nights', async (req): Promise<SleepNight[]> => {
    const q = nightsQuery.parse(req.query);
    checkDayOrder(q.fromDay, q.toDay);
    const rows = all<NightRow>(
      app.db,
      `SELECT ${NIGHT_COLS} FROM health_sleep_nights
       WHERE athlete_id = ? AND day >= ? AND day <= ? AND (? = 'all' OR kind = ?)
       ORDER BY day, bed_ts`,
      [req.athleteId, q.fromDay ?? '0000-00-00', q.toDay ?? '9999-12-31', q.kind, q.kind],
    );
    return rows.map(toNight);
  });

  // One night with its hypnogram segments and the physiology recorded during it
  app.get('/sleep/night', async (req): Promise<SleepNightDetail> => {
    const q = nightQuery.parse(req.query);
    let row: NightRow | undefined;
    if (q.id !== undefined) {
      row = get<NightRow>(
        app.db,
        `SELECT ${NIGHT_COLS}, segments FROM health_sleep_nights WHERE athlete_id = ? AND id = ?`,
        [req.athleteId, q.id],
      );
    } else if (q.day) {
      row = get<NightRow>(
        app.db,
        `SELECT ${NIGHT_COLS}, segments FROM health_sleep_nights
         WHERE athlete_id = ? AND day = ? AND kind = 'night' ORDER BY bed_ts LIMIT 1`,
        [req.athleteId, q.day],
      );
    } else {
      row = get<NightRow>(
        app.db,
        `SELECT ${NIGHT_COLS}, segments FROM health_sleep_nights
         WHERE athlete_id = ? AND kind = 'night' ORDER BY day DESC LIMIT 1`,
        [req.athleteId],
      );
    }
    if (!row) throw notFound('Sleep night');
    const night = toNight(row);
    return { ...night, segments: segmentsOf(row.segments, night.bedTs), physiology: sleepPhysiology(app.db, req.athleteId, night) };
  });
}
