import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BloodPressureReading } from '@cadence/shared';
import { all } from '../../db/db';
import { localDay } from '../../lib/time';
import { checkDayOrder, dayParam, localDayRange, localDaySql } from './util';

const bpQuery = z.object({
  fromDay: dayParam.optional(),
  toDay: dayParam.optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(2000),
});

const SYS = 'HKQuantityTypeIdentifierBloodPressureSystolic';
const DIA = 'HKQuantityTypeIdentifierBloodPressureDiastolic';
const BP_CORRELATION = 'HKCorrelationTypeIdentifierBloodPressure';
const PULSE = 'HKQuantityTypeIdentifierHeartRate';

interface CorrelationItem {
  type: string;
  value: number | null;
}

/** Systolic / diastolic (and pulse, when the cuff wrote one) out of the items of a blood pressure correlation. */
export function readBloodPressureItems(
  items: CorrelationItem[],
): { systolic: number; diastolic: number; pulse: number | null } | null {
  let systolic: number | null = null;
  let diastolic: number | null = null;
  let pulse: number | null = null;
  for (const it of items) {
    if (typeof it.value !== 'number' || !Number.isFinite(it.value)) continue;
    if (it.type === SYS) systolic = it.value;
    else if (it.type === DIA) diastolic = it.value;
    else if (it.type === PULSE) pulse = it.value;
  }
  return systolic !== null && diastolic !== null ? { systolic, diastolic, pulse } : null;
}

export function registerBodyRoutes(app: FastifyInstance): void {
  // Blood pressure readings (the newest `limit` of the range, oldest first): from <Correlation> elements; without any,
  // systolic/diastolic records of the same instant are paired
  app.get('/body/blood-pressure', async (req): Promise<BloodPressureReading[]> => {
    const q = bpQuery.parse(req.query);
    checkDayOrder(q.fromDay, q.toDay);
    const range = localDayRange(q.fromDay, q.toDay);
    const inRange = (day: string) => (!q.fromDay || day >= q.fromDay) && (!q.toDay || day <= q.toDay);

    const out: BloodPressureReading[] = [];
    const c = localDaySql('c', range);
    const rows = all<{ start_ts: number; tz_min: number; items: string; source: string | null }>(
      app.db,
      `SELECT c.start_ts, c.tz_min, c.items, s.name AS source
       FROM correlations c LEFT JOIN sources s ON s.id = c.source_id
       WHERE c.athlete_id = ? AND c.type = ? AND ${c.sql}
       ORDER BY c.start_ts DESC LIMIT ?`,
      [req.athleteId, BP_CORRELATION, ...c.params, q.limit],
    ).reverse();
    for (const r of rows) {
      let items: CorrelationItem[] = [];
      try {
        items = JSON.parse(r.items) as CorrelationItem[];
      } catch {
        continue;
      }
      const v = readBloodPressureItems(items);
      const day = localDay(r.start_ts, r.tz_min);
      if (!v || !inRange(day)) continue;
      out.push({ ts: r.start_ts, tzMin: r.tz_min, day, ...v, source: r.source });
    }
    if (out.length) return out;

    // fallback: separate systolic and diastolic records that share their start time
    const rec = all<{ start_ts: number; tz_min: number; value: number; ident: string; source: string | null }>(
      app.db,
      `SELECT r.start_ts, r.tz_min, r.value, t.identifier AS ident, s.name AS source
       FROM records r JOIN record_types t ON t.id = r.type_id LEFT JOIN sources s ON s.id = r.source_id
       WHERE r.athlete_id = ? AND t.identifier IN (?, ?) AND r.start_ts >= ? AND r.start_ts < ? AND r.value IS NOT NULL
       ORDER BY r.start_ts`,
      [req.athleteId, SYS, DIA, range.lo, range.hi],
    );
    const pairs = new Map<number, { sys?: number; dia?: number; tz: number; source: string | null }>();
    for (const r of rec) {
      const p = pairs.get(r.start_ts) ?? { tz: r.tz_min, source: r.source };
      if (r.ident === SYS) p.sys = r.value;
      else p.dia = r.value;
      pairs.set(r.start_ts, p);
    }
    for (const [ts, p] of pairs) {
      const day = localDay(ts, p.tz);
      if (p.sys === undefined || p.dia === undefined || !inRange(day)) continue;
      out.push({ ts, tzMin: p.tz, day, systolic: p.sys, diastolic: p.dia, pulse: null, source: p.source });
    }
    return out.slice(-q.limit);
  });
}
