import { all, get, prepare, run, tx, type Db } from '../../db/db';
import { recomputeDailyMetrics, refreshTypeStats } from '../../derive/daily';
import type { Aggregation } from '../../import/hk';
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
  /** 'sum' for daily totals (weeks add up, today is incomplete), else 'avg' (default). */
  aggregation?: 'sum' | 'avg';
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
  {
    identifier: 'COROSSteps',
    unit: 'count',
    pick: (d) => d.steps as number | undefined,
    range: [1, 200_000],
    aggregation: 'sum',
  },
  {
    identifier: 'COROSCalories',
    unit: 'kcal',
    pick: (d) => d.kcal as number | undefined,
    range: [1, 20_000],
    aggregation: 'sum',
  },
  {
    identifier: 'COROSActiveMinutes',
    unit: 'min',
    pick: (d) => d.activeMin as number | undefined,
    range: [1, 1440],
    aggregation: 'sum',
  },
  { identifier: 'COROSHeartRate', unit: 'count/min', pick: (d) => d.hrAvg as number | undefined, range: [25, 240] },
  { identifier: 'COROSHeartRateMin', unit: 'count/min', pick: (d) => d.hrMin as number | undefined, range: [25, 240] },
  { identifier: 'COROSHeartRateMax', unit: 'count/min', pick: (d) => d.hrMax as number | undefined, range: [25, 240] },
];

const ALL_METRICS = [...COROS_METRICS, ...COROS_MOBILE_METRICS];

function ensureTypes(db: Db, specs: MetricSpec[]): Map<string, number> {
  const ids = new Map<string, number>();
  for (const m of specs) {
    // one record per day: 'sum' and 'avg' give the same daily value, but weeks, months and today differ
    const row = get<{ id: number }>(
      db,
      `INSERT INTO record_types (identifier, kind, unit, aggregation) VALUES (?, 'quantity', ?, ?)
       ON CONFLICT (identifier) DO UPDATE SET aggregation = excluded.aggregation RETURNING id`,
      [m.identifier, m.unit, m.aggregation ?? 'avg'],
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
  const rows = all<{ id: number; identifier: string; kind: string; aggregation: Aggregation }>(
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
  deleteCorosRings(db, athleteId);
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
  // rings are stored once for the whole range: a day's goal can come from a day in another window
  const calendar: MobileDay[] = [];
  for (let w = 0; w < (opts.maxWindows ?? 60); w++) {
    const start = addDaysStr(end, -(MOBILE_WINDOW_DAYS - 1));
    const lists: Partial<Record<keyof typeof MOBILE_DATA, MobileDay[]>> = {};
    for (const key of ['steps', 'calories', 'activeTime', 'heartRate', 'sleep', 'calendar'] as const)
      lists[key] = await daily(MOBILE_DATA[key], Number(compact(start)), Number(compact(end)));
    const r = storeCorosDays(db, athleteId, mobileRows(lists), COROS_MOBILE_METRICS);
    const s = storeCorosNights(db, athleteId, lists.sleep ?? []);
    calendar.push(...(lists.calendar ?? []));
    days += r.days;
    nights += s.nights;
    for (const e of [r.earliest, s.earliest]) if (e && (!earliest || e < earliest)) earliest = e;
    if (opts.sinceDay && start <= opts.sinceDay) break;
    emptyRun = r.days || s.nights ? 0 : emptyRun + 1;
    if (!opts.sinceDay && emptyRun >= 2) break;
    end = addDaysStr(start, -1);
  }
  storeCorosRings(db, athleteId, calendar);
  const from = opts.sinceDay ? (earliest ?? opts.sinceDay) : null;
  refreshCorosMetrics(db, athleteId, from);
  rebuildSleepNights(db, athleteId, from);
  return { days, nights, earliest };
}

/** Columns of an activity_summaries row (Apple's rings; COROS fills Move and Exercise only). */
const SUMMARY_COLUMNS = [
  'active_energy_kcal',
  'active_energy_goal_kcal',
  'move_time_min',
  'move_time_goal_min',
  'exercise_min',
  'exercise_goal_min',
  'stand_hours',
  'stand_goal_hours',
] as const;
type Summary = Record<(typeof SUMMARY_COLUMNS)[number], number | null>;

/** One day of COROS rings as COROS reports them (connect_rings). */
interface CorosRing {
  active_energy_kcal: number | null;
  active_energy_goal_kcal: number | null;
  exercise_min: number | null;
  exercise_goal_min: number | null;
}

const asSummary = (r: CorosRing): Summary => ({
  active_energy_kcal: r.active_energy_kcal,
  active_energy_goal_kcal: r.active_energy_goal_kcal,
  move_time_min: null,
  move_time_goal_min: null,
  exercise_min: r.exercise_min,
  exercise_goal_min: r.exercise_goal_min,
  stand_hours: null,
  stand_goal_hours: null,
});
const sameSummary = (a: Summary, b: Summary) => SUMMARY_COLUMNS.every((c) => (a[c] ?? null) === (b[c] ?? null));
/** A row an earlier version stored for COROS right in activity_summaries: no Stand / Move time, whole numbers. */
const legacyCorosRow = (s: Summary) =>
  s.move_time_min === null &&
  s.move_time_goal_min === null &&
  s.stand_hours === null &&
  s.stand_goal_hours === null &&
  Number.isInteger(s.active_energy_kcal ?? 0) &&
  Number.isInteger(s.exercise_min ?? 0);
const parseSummary = (json: string | null): Summary | null => {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<Summary>;
    return Object.fromEntries(SUMMARY_COLUMNS.map((c) => [c, typeof v[c] === 'number' ? v[c] : null])) as Summary;
  } catch {
    return null;
  }
};
const summaryOf = (row: Record<string, unknown>): Summary =>
  Object.fromEntries(SUMMARY_COLUMNS.map((c) => [c, typeof row[c] === 'number' ? row[c] : null])) as Summary;

/** COROS sets goals in steps: calories in 10 kcal, active time in 5 min. Shares below `minValue` are too rough. */
const KCAL_GOAL = { step: 10, minValue: 20 };
const MIN_GOAL = { step: 5, minValue: 5 };

/**
 * Daily goals of one ring from COROS' shares (whole percent, capped at 100), days in ascending order. A share of
 * 20–99 % with enough progress gives the goal; other days take the last such goal before them – the first days
 * the goal stored before them (`seed`), else the next one found – and else a rough estimate from their own share.
 * The goal always agrees with COROS: below 100 % it is above the value (open ring), at 100 % at most the value
 * (closed). Without a share there is only a known goal or none, never the day's own value.
 */
export function corosRingGoals(
  days: { value: number; rate: number | undefined }[],
  seed: number | null,
  unit: { step: number; minValue: number },
): (number | null)[] {
  const round = (x: number) => Math.max(unit.step, Math.round(x / unit.step) * unit.step);
  const exact = days.map(({ value, rate }) =>
    typeof rate === 'number' && rate >= 20 && rate < 100 && value >= unit.minValue ? round((value * 100) / rate) : null,
  );
  let last = seed ?? exact.find((g) => g !== null) ?? null;
  return days.map(({ value, rate }, i) => {
    if (exact[i] !== null) last = exact[i]!;
    let goal = last;
    if (typeof rate !== 'number') return goal;
    if (rate >= 100) return goal === null ? (value > 0 ? value : null) : Math.min(goal, value);
    if (goal === null && rate > 0 && value > 0) goal = round((value * 100) / rate);
    if (goal === null) return null;
    return Math.max(goal, (Math.floor(value / unit.step) + 1) * unit.step);
  });
}

function ringStatements(db: Db) {
  return {
    summary: prepare(
      db,
      `SELECT ${SUMMARY_COLUMNS.join(', ')} FROM activity_summaries WHERE athlete_id = ? AND day = ?`,
    ),
    putSummary: prepare(
      db,
      `INSERT INTO activity_summaries (athlete_id, day, ${SUMMARY_COLUMNS.join(', ')})
       VALUES (?, ?, ${SUMMARY_COLUMNS.map(() => '?').join(', ')})
       ON CONFLICT (athlete_id, day) DO UPDATE SET ${SUMMARY_COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')}`,
    ),
    putRing: prepare(
      db,
      `INSERT INTO connect_rings (athlete_id, provider, day, active_energy_kcal, active_energy_goal_kcal, exercise_min,
         exercise_goal_min, replaced)
       VALUES (?, 'coros', ?, ?, ?, ?, ?, ?)
       ON CONFLICT (athlete_id, provider, day) DO UPDATE SET active_energy_kcal = excluded.active_energy_kcal,
         active_energy_goal_kcal = excluded.active_energy_goal_kcal, exercise_min = excluded.exercise_min,
         exercise_goal_min = excluded.exercise_goal_min, replaced = excluded.replaced`,
    ),
  };
}

/**
 * Bring one day of activity_summaries in line with the preferred source: COROS' rings where the watch is preferred
 * or Apple has none, else Apple's. `owned`: the row shows COROS' rings right now. Returns the Apple row the COROS
 * rings replace (kept in connect_rings.replaced, so preferring Apple again restores it).
 */
function settleRingDay(
  st: ReturnType<typeof ringStatements>,
  athleteId: number,
  day: string,
  coros: Summary,
  replaced: Summary | null,
  cur: Summary | undefined,
  owned: boolean,
  preferDevice: boolean,
): Summary | null {
  const apple = owned ? replaced : (cur ?? null);
  if (apple && !preferDevice) {
    if (owned) st.putSummary.run(athleteId, day, ...SUMMARY_COLUMNS.map((c) => apple[c]));
    return null;
  }
  if (!cur || !sameSummary(cur, coros)) st.putSummary.run(athleteId, day, ...SUMMARY_COLUMNS.map((c) => coros[c]));
  return apple;
}

/**
 * The COROS app's daily goals as activity rings: calories → Move, active time → Exercise (COROS has no Stand ring).
 * The goals come from COROS' share of each goal (corosRingGoals). COROS' own copy of each day is kept in
 * connect_rings; activity_summaries shows it where Apple has no rings or the athlete prefers the watch's own data
 * (Settings → My watch), and follows it while the day's values change. Returns the number of days stored.
 */
export function storeCorosRings(db: Db, athleteId: number, days: MobileDay[]): number {
  const preferDevice = preferred(getSettings(db, athleteId), 'heart') === 'device';
  const byDay = new Map<string, NonNullable<MobileDay['calendarData']>>();
  for (const d of days) {
    const day = dayOf(d.happenDay);
    if (day && d.calendarData) byDay.set(day, d.calendarData);
  }
  const rows = [...byDay]
    .map(([day, c]) => ({
      day,
      kcal: Math.round((c.calorie ?? 0) / 1000),
      min: Math.round((c.motionTime ?? 0) / 60),
      kcalRate: c.calorieStandardRate,
      minRate: c.motionTimeStandardRate,
    }))
    .filter((r) => r.kcal || r.min)
    .sort((a, b) => a.day.localeCompare(b.day));
  if (!rows.length) return 0;
  // the goals in effect before these days (stored by an earlier sync)
  const seed = (column: 'active_energy_goal_kcal' | 'exercise_goal_min') =>
    get<{ g: number }>(
      db,
      `SELECT ${column} AS g FROM connect_rings
       WHERE athlete_id = ? AND provider = 'coros' AND day < ? AND ${column} IS NOT NULL ORDER BY day DESC LIMIT 1`,
      [athleteId, rows[0]!.day],
    )?.g ?? null;
  const kcalGoals = corosRingGoals(
    rows.map((r) => ({ value: r.kcal, rate: r.kcalRate })),
    seed('active_energy_goal_kcal'),
    KCAL_GOAL,
  );
  const minGoals = corosRingGoals(
    rows.map((r) => ({ value: r.min, rate: r.minRate })),
    seed('exercise_goal_min'),
    MIN_GOAL,
  );
  const st = ringStatements(db);
  const mine = prepare(
    db,
    `SELECT active_energy_kcal, active_energy_goal_kcal, exercise_min, exercise_goal_min, replaced FROM connect_rings
     WHERE athlete_id = ? AND provider = 'coros' AND day = ?`,
  );
  tx(db, () => {
    rows.forEach((r, i) => {
      const ring: CorosRing = {
        active_energy_kcal: r.kcal,
        active_energy_goal_kcal: kcalGoals[i]!,
        exercise_min: r.min,
        exercise_goal_min: minGoals[i]!,
      };
      const prev = mine.get(athleteId, r.day) as (CorosRing & { replaced: string | null }) | undefined;
      const row = st.summary.get(athleteId, r.day) as Record<string, unknown> | undefined;
      const cur = row ? summaryOf(row) : undefined;
      // the row shows COROS' rings when it holds what COROS stored last (or what an earlier version stored)
      const owned = !!cur && (prev ? sameSummary(cur, asSummary(prev)) : legacyCorosRow(cur));
      const replaced = settleRingDay(
        st,
        athleteId,
        r.day,
        asSummary(ring),
        parseSummary(prev?.replaced ?? null),
        cur,
        owned,
        preferDevice,
      );
      st.putRing.run(
        athleteId,
        r.day,
        ring.active_energy_kcal,
        ring.active_energy_goal_kcal,
        ring.exercise_min,
        ring.exercise_goal_min,
        replaced ? JSON.stringify(replaced) : null,
      );
    });
  });
  return rows.length;
}

/**
 * Apply the ring source preference to every stored COROS day again: after the preference changed (Settings → My
 * watch) or an Apple import rewrote days. Runs in the connect derive step; cheap (one row per day).
 */
export function reconcileCorosRings(db: Db, athleteId: number): void {
  const rows = all<Record<string, unknown> & CorosRing & { day: string; replaced: string | null; has: number }>(
    db,
    `SELECT c.day, c.replaced, c.active_energy_kcal, c.active_energy_goal_kcal, c.exercise_min, c.exercise_goal_min,
       a.day IS NOT NULL AS has, ${SUMMARY_COLUMNS.map((col) => `a.${col} AS a_${col}`).join(', ')}
     FROM connect_rings c LEFT JOIN activity_summaries a ON a.athlete_id = c.athlete_id AND a.day = c.day
     WHERE c.athlete_id = ? AND c.provider = 'coros' ORDER BY c.day`,
    [athleteId],
  );
  if (!rows.length) return;
  const preferDevice = preferred(getSettings(db, athleteId), 'heart') === 'device';
  const st = ringStatements(db);
  const setReplaced = prepare(
    db,
    "UPDATE connect_rings SET replaced = ? WHERE athlete_id = ? AND provider = 'coros' AND day = ?",
  );
  tx(db, () => {
    for (const r of rows) {
      const coros = asSummary(r);
      const cur = r.has
        ? (Object.fromEntries(SUMMARY_COLUMNS.map((c) => [c, (r[`a_${c}`] as number | null) ?? null])) as Summary)
        : undefined;
      const replaced = settleRingDay(
        st,
        athleteId,
        r.day,
        coros,
        parseSummary(r.replaced),
        cur,
        !!cur && sameSummary(cur, coros),
        preferDevice,
      );
      const json = replaced ? JSON.stringify(replaced) : null;
      if (json !== r.replaced) setReplaced.run(json, athleteId, r.day);
    }
  });
}

/** Take COROS' rings out of activity_summaries (Apple's come back where COROS replaced them). */
export function deleteCorosRings(db: Db, athleteId: number): void {
  const rows = all<CorosRing & { day: string; replaced: string | null }>(
    db,
    `SELECT day, active_energy_kcal, active_energy_goal_kcal, exercise_min, exercise_goal_min, replaced FROM connect_rings
     WHERE athlete_id = ? AND provider = 'coros'`,
    [athleteId],
  );
  const st = ringStatements(db);
  tx(db, () => {
    for (const r of rows) {
      const row = st.summary.get(athleteId, r.day) as Record<string, unknown> | undefined;
      if (!row || !sameSummary(summaryOf(row), asSummary(r))) continue; // Apple's rings (or none): keep
      const apple = parseSummary(r.replaced);
      if (apple) st.putSummary.run(athleteId, r.day, ...SUMMARY_COLUMNS.map((c) => apple[c]));
      else run(db, 'DELETE FROM activity_summaries WHERE athlete_id = ? AND day = ?', [athleteId, r.day]);
    }
    run(db, "DELETE FROM connect_rings WHERE athlete_id = ? AND provider = 'coros'", [athleteId]);
  });
}
