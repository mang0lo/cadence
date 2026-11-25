import { all, run, tx, type Db } from '../../db/db';
import { SLEEP_TYPE } from '../../import/hk';
import { getSetting, getSettings, setSetting } from '../../core/settings';
import { preferred } from '../../core/sources';
import { addDays, parseDay } from '../../lib/time';
import { tzOffsetMinutes } from '../../lib/tz';
import type { DeriveStep } from '../types';
import { buildSleepNights, type BuiltSleep, type RawSleepRecord } from './sleep-builder';
import { localDayRange, typeIdByIdentifier } from './util';

interface SleepRecordRow {
  start_ts: number;
  end_ts: number;
  tz_min: number;
  text: string;
  source_id: number;
  name: string | null;
}

function insertNight(db: Db, athleteId: number, n: BuiltSleep): void {
  run(
    db,
    `INSERT OR REPLACE INTO health_sleep_nights
       (athlete_id, day, kind, bed_ts, wake_ts, tz_bed_min, tz_wake_min, onset_ts, final_ts, in_bed_s, asleep_s,
        core_s, deep_s, rem_s, unspec_s, awake_s, awakenings, latency_s, efficiency, staged, source, segments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      athleteId,
      n.day,
      n.kind,
      n.bedTs,
      n.wakeTs,
      n.tzBedMin,
      n.tzWakeMin,
      n.onsetTs,
      n.finalTs,
      Math.round(n.inBedS),
      Math.round(n.asleepS),
      Math.round(n.coreS),
      Math.round(n.deepS),
      Math.round(n.remS),
      Math.round(n.unspecS),
      Math.round(n.awakeS),
      n.awakenings,
      n.latencyS === null ? null : Math.round(n.latencyS),
      n.efficiency,
      n.staged ? 1 : 0,
      n.source,
      JSON.stringify(n.segments),
    ],
  );
}

/**
 * Setting: the heart source preference ('apple' | 'device') the stored nights were built with. It decides whether
 * Apple's or the watch's night wins on a day with both (mergeExternalNights).
 */
const NIGHTS_SOURCE_KEY = 'health.sleepNightsSource';

/**
 * Rebuild the sleep nights of an athlete. With `sinceDay` only nights waking up on or after (sinceDay − 2) are
 * recomputed from the records of the days around them; `null` rebuilds everything. A heart source preference that
 * changed since the nights were built (or is not known) rebuilds everything too: the history must not mix Apple's and
 * the watch's nights. Returns the number of stored sessions.
 */
export function rebuildSleepNights(db: Db, athleteId: number, sinceDay: string | null, check?: () => void): number {
  const source = preferred(getSettings(db, athleteId), 'heart');
  if (getSetting<string | null>(db, athleteId, NIGHTS_SOURCE_KEY, null) !== source) sinceDay = null;
  const typeId = typeIdByIdentifier(db, SLEEP_TYPE);
  const fromDay = sinceDay ? addDays(sinceDay, -2) : null;
  if (typeId === null) {
    // no Apple sleep data (left): only nights from device clouds
    return tx(db, () => {
      run(db, 'DELETE FROM health_sleep_nights WHERE athlete_id = ? AND day >= ?', [athleteId, fromDay ?? '0000-00-00']);
      setSetting(db, athleteId, NIGHTS_SOURCE_KEY, source);
      return mergeExternalNights(db, athleteId, fromDay);
    });
  }
  // records from well before fromDay so sessions that end on fromDay are complete
  const lo = fromDay ? localDayRange(addDays(fromDay, -2)).lo : -1e12;
  const rows = all<SleepRecordRow>(
    db,
    `SELECT r.start_ts, r.end_ts, r.tz_min, r.text, r.source_id, s.name
     FROM records r LEFT JOIN sources s ON s.id = r.source_id
     WHERE r.athlete_id = ? AND r.type_id = ? AND r.start_ts >= ? AND r.text IS NOT NULL
     ORDER BY r.start_ts`,
    [athleteId, typeId, lo],
  );
  check?.();
  const records: RawSleepRecord[] = rows.map((r) => ({
    startTs: r.start_ts,
    endTs: r.end_ts,
    tzMin: r.tz_min,
    text: r.text,
    sourceId: r.source_id,
    sourceName: r.name,
  }));
  const nights = buildSleepNights(records).filter((n) => !fromDay || n.day >= fromDay);
  return tx(db, () => {
    run(db, 'DELETE FROM health_sleep_nights WHERE athlete_id = ? AND day >= ?', [athleteId, fromDay ?? '0000-00-00']);
    for (const n of nights) insertNight(db, athleteId, n);
    setSetting(db, athleteId, NIGHTS_SOURCE_KEY, source);
    return nights.length + mergeExternalNights(db, athleteId, fromDay);
  });
}

interface ExternalNightRow {
  source: string;
  day: string;
  asleep_s: number;
  deep_s: number;
  light_s: number;
  rem_s: number;
  awake_s: number;
  avg_hr: number | null;
  min_hr: number | null;
}

/** Assumed wake-up time of nights without times (only used to place them on the right day; timed = 0). */
const UNTIMED_WAKE_MIN = 7 * 60;
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Add the nights device clouds report as totals (COROS) to health_sleep_nights: they fill days without an Apple night,
 * and replace Apple's nights when the athlete prefers the watch's own data (Settings → My watch). Their bed / wake
 * times are unknown (timed = 0): the schedule charts and sleep timing skip them.
 */
export function mergeExternalNights(db: Db, athleteId: number, fromDay: string | null): number {
  const rows = all<ExternalNightRow>(
    db,
    `SELECT source, day, asleep_s, deep_s, light_s, rem_s, awake_s, avg_hr, min_hr FROM health_external_nights
     WHERE athlete_id = ? AND day >= ? AND asleep_s > 0 ORDER BY day`,
    [athleteId, fromDay ?? '0000-00-00'],
  );
  if (!rows.length) return 0;
  const preferDevice = preferred(getSettings(db, athleteId), 'heart') === 'device';
  const existing = new Set(
    all<{ day: string }>(
      db,
      `SELECT day FROM health_sleep_nights WHERE athlete_id = ? AND kind = 'night' AND day >= ?`,
      [athleteId, fromDay ?? '0000-00-00'],
    ).map((r) => r.day),
  );
  let n = 0;
  for (const r of rows) {
    if (existing.has(r.day)) {
      if (!preferDevice) continue;
      run(db, `DELETE FROM health_sleep_nights WHERE athlete_id = ? AND kind = 'night' AND day = ?`, [athleteId, r.day]);
    }
    const midnightUtc = (parseDay(r.day) ?? 0) * 86400;
    const tz = tzOffsetMinutes(localZone, midnightUtc + 12 * 3600) ?? 0;
    const wake = midnightUtc - tz * 60 + UNTIMED_WAKE_MIN * 60;
    const inBed = r.asleep_s + r.awake_s;
    const staged = r.deep_s + r.light_s + r.rem_s > 0;
    run(
      db,
      `INSERT OR REPLACE INTO health_sleep_nights
         (athlete_id, day, kind, bed_ts, wake_ts, tz_bed_min, tz_wake_min, onset_ts, final_ts, in_bed_s, asleep_s,
          core_s, deep_s, rem_s, unspec_s, awake_s, awakenings, latency_s, efficiency, staged, source, segments, timed,
          avg_hr, min_hr)
       VALUES (?, ?, 'night', ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, '[]', 0, ?, ?)`,
      [
        athleteId,
        r.day,
        wake - inBed,
        wake,
        tz,
        tz,
        inBed,
        r.asleep_s,
        r.light_s,
        r.deep_s,
        r.rem_s,
        staged ? 0 : r.asleep_s,
        r.awake_s,
        inBed > 0 ? r.asleep_s / inBed : null,
        staged ? 1 : 0,
        r.source,
        r.avg_hr,
        r.min_hr,
      ],
    );
    n++;
  }
  return n;
}

export const sleepStep: DeriveStep = {
  id: 'health.sleep',
  label: 'Sleep nights',
  weight: 1,
  run(ctx) {
    ctx.report(0.1);
    const n = rebuildSleepNights(ctx.db, ctx.athleteId, ctx.sinceDay, ctx.checkCancelled);
    ctx.log(`health.sleep: ${n} sleep sessions`);
    ctx.report(1);
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Row mapping (used by the routes)
// ---------------------------------------------------------------------------------------------------------------

export interface NightRow {
  id: number;
  day: string;
  kind: 'night' | 'nap';
  bed_ts: number;
  wake_ts: number;
  tz_bed_min: number;
  tz_wake_min: number;
  onset_ts: number | null;
  final_ts: number | null;
  in_bed_s: number;
  asleep_s: number;
  core_s: number;
  deep_s: number;
  rem_s: number;
  unspec_s: number;
  awake_s: number;
  awakenings: number;
  latency_s: number | null;
  efficiency: number | null;
  staged: number;
  source: string | null;
  timed: number;
  avg_hr: number | null;
  min_hr: number | null;
  segments?: string;
}

export const NIGHT_COLS = `id, day, kind, bed_ts, wake_ts, tz_bed_min, tz_wake_min, onset_ts, final_ts, in_bed_s, asleep_s,
  core_s, deep_s, rem_s, unspec_s, awake_s, awakenings, latency_s, efficiency, staged, source, timed, avg_hr, min_hr`;

export function toNight(r: NightRow) {
  return {
    id: r.id,
    day: r.day,
    kind: r.kind,
    bedTs: r.bed_ts,
    wakeTs: r.wake_ts,
    tzBedMin: r.tz_bed_min,
    tzWakeMin: r.tz_wake_min,
    onsetTs: r.onset_ts,
    finalTs: r.final_ts,
    inBedS: r.in_bed_s,
    asleepS: r.asleep_s,
    coreS: r.core_s,
    deepS: r.deep_s,
    remS: r.rem_s,
    unspecS: r.unspec_s,
    awakeS: r.awake_s,
    awakenings: r.awakenings,
    latencyS: r.latency_s,
    efficiency: r.efficiency,
    staged: r.staged === 1,
    source: r.source,
    timed: r.timed !== 0,
    avgHr: r.avg_hr,
    minHr: r.min_hr,
  };
}
