import { all, run, tx, type Db } from '../../db/db';
import { SLEEP_TYPE } from '../../import/hk';
import { addDays, parseDay } from '../../lib/time';
import type { DeriveStep } from '../types';
import { buildSleepNights, type BuiltSleep, type RawSleepRecord } from './sleep-builder';
import { typeIdByIdentifier } from './util';

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
 * Rebuild the sleep nights of an athlete. With `sinceDay` only nights waking up on or after (sinceDay − 2) are
 * recomputed from the records of the days around them; `null` rebuilds everything.
 * Returns the number of stored sessions.
 */
export function rebuildSleepNights(db: Db, athleteId: number, sinceDay: string | null, check?: () => void): number {
  const typeId = typeIdByIdentifier(db, SLEEP_TYPE);
  const fromDay = sinceDay ? addDays(sinceDay, -2) : null;
  if (typeId === null) {
    // no sleep data (left): nothing to keep
    run(db, 'DELETE FROM health_sleep_nights WHERE athlete_id = ? AND day >= ?', [athleteId, fromDay ?? '0000-00-00']);
    return 0;
  }
  // records from well before fromDay so sessions that end on fromDay are complete (offsets reach ±14 h)
  const lo = fromDay ? (parseDay(addDays(fromDay, -2)) ?? 0) * 86400 - 14 * 3600 : -1e12;
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
  tx(db, () => {
    run(db, 'DELETE FROM health_sleep_nights WHERE athlete_id = ? AND day >= ?', [athleteId, fromDay ?? '0000-00-00']);
    for (const n of nights) insertNight(db, athleteId, n);
  });
  return nights.length;
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
  segments?: string;
}

export const NIGHT_COLS = `id, day, kind, bed_ts, wake_ts, tz_bed_min, tz_wake_min, onset_ts, final_ts, in_bed_s, asleep_s,
  core_s, deep_s, rem_s, unspec_s, awake_s, awakenings, latency_s, efficiency, staged, source`;

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
  };
}
