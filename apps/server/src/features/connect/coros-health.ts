import { all, get, prepare, run, tx, type Db } from '../../db/db';
import { recomputeDailyMetrics, refreshTypeStats } from '../../derive/daily';
import { fnv1a } from '../../lib/hash';
import { parseDay } from '../../lib/time';
import { getSettings } from '../../core/settings';
import { preferred } from '../../core/sources';
import { rebuildSleepNights } from '../health/sleep';
import { MOBILE_DATA, type MobileDay } from './coros-mobile';

/**
 * Daily health values from COROS Training Hub (EvoLab): resting heart rate, overnight HRV and its baseline, training
 * load, base fitness, fatigue, VO₂max and stamina level. Stored as records of their own types (COROS…, one value per
 * local day, source 'COROS') and aggregated into daily_metrics right away. Which of Apple's and COROS' values the
 * app reads is decided in core/sources.ts.
 *
 * analyse/dayDetail/query answers up to 24 weeks per call (with HRV in dayList): history is fetched window by window
 * going back until two windows in a row hold no data at all.
 */
export const COROS_SOURCE = 'COROS';
/** Days per analyse/dayDetail/query call (COROS accepts up to 24 weeks). */
const WINDOW_DAYS = 168;
/** Days per COROS app statistic request. */
const MOBILE_WINDOW_DAYS = 31;

interface DayRow {
  happenDay?: number;
  rhr?: number;
  avgSleepHrv?: number;
  sleepHrvBase?: number;
  trainingLoad?: number;
  ati?: number;
  cti?: number;
  trainingLoadRatio?: number;
  tiredRate?: number;
  vo2max?: number;
  staminaLevel?: number;
  [key: string]: unknown;
}

interface MetricSpec {
  identifier: string;
  unit: string | null;
  pick: (d: DayRow) => number | undefined;
  /** Plausible range; 0 and anything outside means "no value". */
  range: [number, number];
}

export const COROS_METRICS: MetricSpec[] = [
  { identifier: 'COROSRestingHeartRate', unit: 'count/min', pick: (d) => d.rhr, range: [25, 140] },
  { identifier: 'COROSSleepHRV', unit: 'ms', pick: (d) => d.avgSleepHrv, range: [3, 300] },
  { identifier: 'COROSSleepHRVBaseline', unit: 'ms', pick: (d) => d.sleepHrvBase, range: [3, 300] },
  { identifier: 'COROSTrainingLoad', unit: null, pick: (d) => d.trainingLoad, range: [1, 5000] },
  { identifier: 'COROSAcuteLoad', unit: null, pick: (d) => d.ati, range: [1, 5000] },
  { identifier: 'COROSBaseFitness', unit: null, pick: (d) => d.cti, range: [1, 5000] },
  { identifier: 'COROSLoadRatio', unit: null, pick: (d) => d.trainingLoadRatio, range: [0.01, 10] },
  { identifier: 'COROSFatigue', unit: null, pick: (d) => d.tiredRate, range: [1, 200] },
  { identifier: 'COROSVO2Max', unit: 'mL/min·kg', pick: (d) => d.vo2max, range: [10, 95] },
  { identifier: 'COROSStaminaLevel', unit: null, pick: (d) => d.staminaLevel, range: [1, 200] },
];

/** 20261103 → '2026-11-03' */
const dayOf = (n: number | undefined): string | null => {
  if (!n || n < 19900101) return null;
  const s = String(n);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};
const compact = (day: string) => day.replace(/-/g, '');
const addDaysStr = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/** Daily values of the COROS app API (coros-mobile.ts), flattened by mobileRows(). */
export const COROS_MOBILE_METRICS: MetricSpec[] = [
  { identifier: 'COROSSteps', unit: 'count', pick: (d) => d.steps as number | undefined, range: [1, 200_000] },
  { identifier: 'COROSCalories', unit: 'kcal', pick: (d) => d.kcal as number | undefined, range: [1, 20_000] },
  { identifier: 'COROSActiveMinutes', unit: 'min', pick: (d) => d.activeMin as number | undefined, range: [1, 1440] },
  { identifier: 'COROSHeartRate', unit: 'count/min', pick: (d) => d.hrAvg as number | undefined, range: [25, 240] },
  { identifier: 'COROSHeartRateMin', unit: 'count/min', pick: (d) => d.hrMin as number | undefined, range: [25, 240] },
  { identifier: 'COROSHeartRateMax', unit: 'count/min', pick: (d) => d.hrMax as number | undefined, range: [25, 240] },
];

const ALL_METRICS = [...COROS_METRICS, ...COROS_MOBILE_METRICS];

function ensureTypes(db: Db, specs: MetricSpec[]): Map<string, number> {
  const ids = new Map<string, number>();
  for (const m of specs) {
    const row = get<{ id: number }>(
      db,
      `INSERT INTO record_types (identifier, kind, unit, aggregation) VALUES (?, 'quantity', ?, 'avg')
       ON CONFLICT (identifier) DO UPDATE SET identifier = excluded.identifier RETURNING id`,
      [m.identifier, m.unit],
    )!;
    ids.set(m.identifier, row.id);
  }
  return ids;
}

function sourceId(db: Db): number {
  return get<{ id: number }>(
    db,
    'INSERT INTO sources (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET name = excluded.name RETURNING id',
    [COROS_SOURCE],
  )!.id;
}

/**
 * Write one value per metric and day (replacing what an earlier sync stored for that day: today's values keep
 * changing until the day is over). Returns the number of days with at least one value.
 */
export function storeCorosDays(
  db: Db,
  athleteId: number,
  days: DayRow[],
  specs: MetricSpec[] = COROS_METRICS,
): { days: number; earliest: string | null } {
  const types = ensureTypes(db, specs);
  const src = sourceId(db);
  const del = prepare(
    db,
    'DELETE FROM records WHERE athlete_id = ? AND type_id = ? AND start_ts = ? AND source_id = ?',
  );
  const ins = prepare(
    db,
    `INSERT OR REPLACE INTO records (athlete_id, type_id, start_ts, hash, end_ts, tz_min, value, text, source_id, device_id, created_ts, meta)
     VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?, NULL, unixepoch(), NULL)`,
  );
  let n = 0;
  let earliest: string | null = null;
  tx(db, () => {
    for (const d of days) {
      const day = dayOf(d.happenDay);
      if (!day) continue;
      // noon UTC with tz 0 → the record's local day is exactly the COROS day
      const ts = Date.parse(`${day}T12:00:00Z`) / 1000;
      let any = false;
      for (const m of specs) {
        const v = m.pick(d);
        if (v === undefined) continue; // not part of this response: keep what an earlier sync stored
        const typeId = types.get(m.identifier)!;
        del.run(athleteId, typeId, ts, src);
        if (typeof v !== 'number' || !Number.isFinite(v) || v < m.range[0] || v > m.range[1]) continue;
        ins.run(athleteId, typeId, ts, fnv1a(`${ts}|${COROS_SOURCE}|${v}`), ts, v, src);
        any = true;
      }
      if (any) {
        n++;
        if (!earliest || day < earliest) earliest = day;
      }
    }
  });
  return { days: n, earliest };
}

/** Rebuild daily_metrics / type stats of the COROS metrics from `fromDay` on (cheap: one value per day). */
export function refreshCorosMetrics(db: Db, athleteId: number, fromDay: string | null): void {
  const rows = all<{ id: number; identifier: string; kind: string; aggregation: 'avg' }>(
    db,
    `SELECT id, identifier, kind, aggregation FROM record_types WHERE identifier IN (${ALL_METRICS.map(() => '?').join(',')})`,
    ALL_METRICS.map((m) => m.identifier),
  );
  const from = fromDay ? parseDay(fromDay) : null;
  for (const t of rows) {
    recomputeDailyMetrics(db, athleteId, t, from === null ? null : from - 1);
    refreshTypeStats(db, athleteId, t.id);
  }
  // the day's lowest / highest heart rate become the band of COROSHeartRate (one value per day otherwise)
  run(
    db,
    `UPDATE daily_metrics AS d SET
       min = (SELECT value FROM daily_metrics m WHERE m.athlete_id = d.athlete_id AND m.metric = 'COROSHeartRateMin' AND m.day = d.day),
       max = (SELECT value FROM daily_metrics m WHERE m.athlete_id = d.athlete_id AND m.metric = 'COROSHeartRateMax' AND m.day = d.day)
     WHERE d.athlete_id = ? AND d.metric = 'COROSHeartRate' AND d.day >= ?`,
    [athleteId, fromDay ?? '0000-00-00'],
  );
}

export interface HealthSyncResult {
  days: number;
  /** Newest day fetched ('YYYY-MM-DD'): the next sync starts a few days before it. */
  lastDay: string;
}

/**
 * Fetch daily values from `sinceDay` (or as far back as COROS has data) up to today, store them and refresh the
 * daily metrics. `onWindow` reports progress per month.
 */
export async function syncCorosHealth(
  db: Db,
  athleteId: number,
  /** GET an API path (envelope unwrapped), e.g. through the sync's re-login wrapper. */
  getJson: <T>(path: string, query?: Record<string, string | number>) => Promise<T>,
  opts: { sinceDay: string | null; today?: string; maxMonths?: number; onWindow?: (fromDay: string) => void },
): Promise<HealthSyncResult> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const maxWindows = opts.maxMonths ?? 120;
  let end = today;
  let total = 0;
  let earliest: string | null = null;
  let emptyRun = 0;
  for (let w = 0; w < maxWindows; w++) {
    const start = addDaysStr(end, -(WINDOW_DAYS - 1));
    opts.onWindow?.(start);
    const data = await getJson<{ dayList?: DayRow[]; t7dayList?: DayRow[] }>('analyse/dayDetail/query', {
      startDay: compact(start),
      endDay: compact(end),
    });
    // t7dayList carries the HRV fields, dayList the longer range: merge per day (dayList first, t7dayList wins)
    const byDay = new Map<number, DayRow>();
    for (const d of [...(data?.dayList ?? []), ...(data?.t7dayList ?? [])])
      if (d?.happenDay) byDay.set(d.happenDay, { ...byDay.get(d.happenDay), ...d });
    const inWindow = [...byDay.values()].filter((d) => {
      const day = dayOf(d.happenDay);
      return day !== null && day >= start && day <= end;
    });
    const r = storeCorosDays(db, athleteId, inWindow);
    total += r.days;
    if (r.earliest && (!earliest || r.earliest < earliest)) earliest = r.earliest;
    if (opts.sinceDay && start <= opts.sinceDay) break;
    // first sync: walk back until two windows in a row have nothing
    emptyRun = r.days ? 0 : emptyRun + 1;
    if (!opts.sinceDay && emptyRun >= 2) break;
    end = addDaysStr(start, -1);
  }
  // VO₂max and stamina level are only in the dashboard (last 7 days): collected over time by each sync
  const dash = await getJson<{ detailList?: DayRow[] }>('dashboard/detail/query');
  const extra = storeCorosDays(
    db,
    athleteId,
    (dash?.detailList ?? []).map((d) => ({
      happenDay: d.happenDay,
      vo2max: d.vo2max,
      staminaLevel: d.staminaLevel,
    })),
  );
  if (extra.earliest && (!earliest || extra.earliest < earliest)) earliest = extra.earliest;
  refreshCorosMetrics(db, athleteId, opts.sinceDay ? (earliest ?? opts.sinceDay) : null);
  return { days: total, lastDay: today };
}

/** Delete every COROS health value (disconnect with "remove data"). */
export function deleteCorosHealth(db: Db, athleteId: number): void {
  const src = get<{ id: number }>(db, 'SELECT id FROM sources WHERE name = ?', [COROS_SOURCE]);
  if (!src) return;
  run(db, 'DELETE FROM records WHERE athlete_id = ? AND source_id = ?', [athleteId, src.id]);
  run(db, 'DELETE FROM health_external_nights WHERE athlete_id = ? AND source = ?', [athleteId, COROS_SOURCE]);
  rebuildSleepNights(db, athleteId, null);
  refreshCorosMetrics(db, athleteId, null);
}

/** Flatten the COROS app's per type day lists into one row per day (input of storeCorosDays with the mobile specs). */
export function mobileRows(lists: Partial<Record<keyof typeof MOBILE_DATA, MobileDay[]>>): DayRow[] {
  const by = new Map<number, DayRow>();
  const row = (d: MobileDay) => {
    let r = by.get(d.happenDay);
    if (!r) by.set(d.happenDay, (r = { happenDay: d.happenDay }));
    return r;
  };
  for (const d of lists.steps ?? []) if (d.step !== undefined) row(d).steps = d.step;
  for (const d of lists.calories ?? []) if (d.calorie !== undefined) row(d).kcal = Math.round(d.calorie / 1000);
  for (const d of lists.activeTime ?? [])
    if (d.motionTime !== undefined) row(d).activeMin = Math.round(d.motionTime / 60);
  for (const d of lists.heartRate ?? []) {
    const h = d.heartRateData;
    if (!h) continue;
    const r = row(d);
    r.hrAvg = h.avgHeartRate;
    r.hrMin = h.minHeartRate;
    r.hrMax = h.maxHeartRate;
  }
  return [...by.values()];
}

/** Store the COROS app's nights (minutes per stage) for health.sleep (health_external_nights). */
export function storeCorosNights(
  db: Db,
  athleteId: number,
  days: MobileDay[],
): { nights: number; earliest: string | null } {
  const ins = prepare(
    db,
    `INSERT OR REPLACE INTO health_external_nights
       (athlete_id, source, day, asleep_s, deep_s, light_s, rem_s, awake_s, nap_s, avg_hr, min_hr, max_hr)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const del = prepare(db, 'DELETE FROM health_external_nights WHERE athlete_id = ? AND source = ? AND day = ?');
  let nights = 0;
  let earliest: string | null = null;
  const pos = (v: number | undefined) => (typeof v === 'number' && v > 0 ? v : null);
  tx(db, () => {
    for (const d of days) {
      const day = dayOf(d.happenDay);
      const s = d.sleepData;
      if (!day || !s) continue;
      const total = pos(s.totalSleepTime);
      if (!total) {
        del.run(athleteId, COROS_SOURCE, day);
        continue;
      }
      ins.run(
        athleteId,
        COROS_SOURCE,
        day,
        total * 60,
        (pos(s.deepTime) ?? 0) * 60,
        (pos(s.lightTime) ?? 0) * 60,
        (pos(s.eyeTime) ?? 0) * 60,
        (pos(s.wakeTime) ?? 0) * 60,
        (pos(s.shortSleepTime) ?? 0) * 60,
        pos(s.avgHeartRate),
        pos(s.minHeartRate),
        pos(s.maxHeartRate),
      );
      nights++;
      if (!earliest || day < earliest) earliest = day;
    }
  });
  return { nights, earliest };
}

export interface MobileSyncResult {
  days: number;
  nights: number;
  earliest: string | null;
}

/**
 * Fetch steps, calories, active time, all-day heart rate and sleep from the COROS app API from `sinceDay` (or as far
 * back as there is data) up to today. `daily` runs one request (dataType, startDay, endDay as YYYYMMDD numbers).
 */
export async function syncCorosMobile(
  db: Db,
  athleteId: number,
  daily: (dataType: number, startDay: number, endDay: number) => Promise<MobileDay[]>,
  opts: { sinceDay: string | null; today?: string; maxWindows?: number },
): Promise<MobileSyncResult> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  let end = today;
  let days = 0;
  let nights = 0;
  let earliest: string | null = null;
  let emptyRun = 0;
  for (let w = 0; w < (opts.maxWindows ?? 60); w++) {
    const start = addDaysStr(end, -(MOBILE_WINDOW_DAYS - 1));
    const lists: Partial<Record<keyof typeof MOBILE_DATA, MobileDay[]>> = {};
    for (const key of ['steps', 'calories', 'activeTime', 'heartRate', 'sleep', 'calendar'] as const)
      lists[key] = await daily(MOBILE_DATA[key], Number(compact(start)), Number(compact(end)));
    const r = storeCorosDays(db, athleteId, mobileRows(lists), COROS_MOBILE_METRICS);
    const s = storeCorosNights(db, athleteId, lists.sleep ?? []);
    storeCorosRings(db, athleteId, lists.calendar ?? []);
    days += r.days;
    nights += s.nights;
    for (const e of [r.earliest, s.earliest]) if (e && (!earliest || e < earliest)) earliest = e;
    if (opts.sinceDay && start <= opts.sinceDay) break;
    emptyRun = r.days || s.nights ? 0 : emptyRun + 1;
    if (!opts.sinceDay && emptyRun >= 2) break;
    end = addDaysStr(start, -1);
  }
  const from = opts.sinceDay ? (earliest ?? opts.sinceDay) : null;
  refreshCorosMetrics(db, athleteId, from);
  rebuildSleepNights(db, athleteId, from);
  return { days, nights, earliest };
}

/**
 * The COROS app's daily goals as activity rings (activity_summaries): calories → Move, active time → Exercise (COROS
 * has no Stand ring). COROS reports the share of each goal in % capped at 100: below 100 it gives the goal exactly
 * (value / share), at 100 the ring is closed and the goal is the last one known (or the value itself). Days with
 * Apple rings keep them unless the athlete prefers the watch's own data (Settings → My watch).
 */
export function storeCorosRings(db: Db, athleteId: number, days: MobileDay[]): number {
  const preferDevice = preferred(getSettings(db, athleteId), 'heart') === 'device';
  const rows = days
    .map((d) => ({ day: dayOf(d.happenDay), c: d.calendarData }))
    .filter((r): r is { day: string; c: NonNullable<MobileDay['calendarData']> } => !!r.day && !!r.c)
    .sort((a, b) => a.day.localeCompare(b.day));
  let kcalGoal: number | null = null;
  let minGoal: number | null = null;
  // shares are whole percent: only days with enough progress give a reliable goal, rounded to COROS' steps
  const goalOf = (value: number, rate: number | undefined, last: number | null, minValue: number, step: number) =>
    rate && rate >= 20 && rate < 100 && value >= minValue
      ? Math.max(step, Math.round((value * 100) / rate / step) * step)
      : (last ?? (value > 0 ? value : null));
  const upsert = prepare(
    db,
    `INSERT INTO activity_summaries (athlete_id, day, active_energy_kcal, active_energy_goal_kcal, exercise_min, exercise_goal_min)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (athlete_id, day) DO UPDATE SET active_energy_kcal = excluded.active_energy_kcal,
       active_energy_goal_kcal = excluded.active_energy_goal_kcal, exercise_min = excluded.exercise_min,
       exercise_goal_min = excluded.exercise_goal_min, move_time_min = NULL, move_time_goal_min = NULL,
       stand_hours = NULL, stand_goal_hours = NULL
     WHERE ?`,
  );
  let n = 0;
  tx(db, () => {
    for (const { day, c } of rows) {
      const kcal = Math.round((c.calorie ?? 0) / 1000);
      const min = Math.round((c.motionTime ?? 0) / 60);
      if (!kcal && !min) continue;
      kcalGoal = goalOf(kcal, c.calorieStandardRate, kcalGoal, 20, 10);
      minGoal = goalOf(min, c.motionTimeStandardRate, minGoal, 5, 5);
      // the stored goal of a closed day is at most its value (else a closed COROS ring would show as open)
      const kg = c.calorieStandardRate === 100 && kcalGoal !== null ? Math.min(kcalGoal, kcal) : kcalGoal;
      const mg = c.motionTimeStandardRate === 100 && minGoal !== null ? Math.min(minGoal, min) : minGoal;
      n += Number(upsert.run(athleteId, day, kcal, kg, min, mg, preferDevice ? 1 : 0).changes);
    }
  });
  return n;
}
