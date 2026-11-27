import {
  APPLE_HEART_METRICS as APPLE,
  DEVICE_HEART_METRICS as DEVICE,
  type AthleteSettings,
  type DataSourcesInfo,
  type HeartMetric,
  type SourcePref,
} from '@cadence/shared';
import { all, get, type Db } from '../db/db';
import { getSetting, getSettings } from './settings';

/**
 * Which source wins when several record the same thing (Settings → "My watch" + per type overrides).
 *
 * COROS values are stored as their own metrics (COROSRestingHeartRate, COROSSleepHRV …) because they are not the
 * same measurement as Apple's (COROS' HRV is an overnight RMSSD, Apple's an SDNN of spot readings): every consumer
 * asks here which identifier to read instead of mixing them. The keys of both sources are in @cadence/shared
 * (APPLE_HEART_METRICS, DEVICE_HEART_METRICS), so the web names the same ones.
 */
export type { HeartMetric };

/** 'device' when the watch's own data (COROS cloud, FIT files) should win, else 'apple'. */
export function preferred(
  settings: Pick<AthleteSettings, 'watch' | 'sources'>,
  kind: keyof AthleteSettings['sources'],
): Exclude<SourcePref, 'auto'> {
  const p = settings.sources?.[kind] ?? 'auto';
  if (p !== 'auto') return p;
  return settings.watch === 'apple' ? 'apple' : 'device';
}

const hasMetric = (db: Db, athleteId: number, metric: string) =>
  get(db, 'SELECT 1 FROM daily_metrics WHERE athlete_id = ? AND metric = ? LIMIT 1', [athleteId, metric]) !==
  undefined;

/** daily_metrics key to read for a heart metric: the preferred source when it has data, else the other one. */
export function heartMetric(
  db: Db,
  athleteId: number,
  metric: HeartMetric,
  settings = getSettings(db, athleteId),
): string {
  const first = preferred(settings, 'heart') === 'device' ? DEVICE : APPLE;
  const second = first === DEVICE ? APPLE : DEVICE;
  if (hasMetric(db, athleteId, first[metric]) || !hasMetric(db, athleteId, second[metric]))
    return first[metric];
  return second[metric];
}

/** True when the device's own copy of a workout (FIT file / COROS) should win over the Apple Health copy. */
export function preferDeviceWorkouts(db: Db, athleteId: number): boolean {
  return preferred(getSettings(db, athleteId), 'workouts') === 'device';
}

const count = (db: Db, sql: string, params: (string | number)[]) =>
  get<{ n: number }>(db, sql, params)?.n ?? 0;

/** What data exists per source (GET /api/sources). Cheap: record_type_stats and indexed counts only. */
export function dataSources(db: Db, athleteId: number): DataSourcesInfo {
  const metrics = all<{ identifier: string; count: number }>(
    db,
    `SELECT t.identifier, s.count FROM record_type_stats s JOIN record_types t ON t.id = s.type_id
     WHERE s.athlete_id = ? AND s.count > 0`,
    [athleteId],
  );
  const coros = getSetting<{ lastSyncAt?: number | null; lastError?: string | null } | null>(
    db,
    athleteId,
    'connect.coros',
    null,
  );
  const hasTable = (name: string) =>
    !!get(db, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name]);
  return {
    watch: getSettings(db, athleteId).watch,
    apple: {
      records: metrics.filter((m) => m.identifier.startsWith('HK')).reduce((a, m) => a + m.count, 0),
      workouts: count(
        db,
        "SELECT COUNT(*) AS n FROM workouts WHERE athlete_id = ? AND ext_key NOT LIKE 'fit:%'",
        [athleteId],
      ),
    },
    coros: {
      connected: !!coros,
      lastSyncAt: coros?.lastSyncAt ?? null,
      lastError: coros?.lastError ?? null,
      workouts: count(
        db,
        "SELECT COUNT(*) AS n FROM workouts WHERE athlete_id = ? AND ext_key LIKE 'fit:%' AND device LIKE 'COROS%'",
        [athleteId],
      ),
    },
    fitWorkouts: count(
      db,
      "SELECT COUNT(*) AS n FROM workouts WHERE athlete_id = ? AND ext_key LIKE 'fit:%'",
      [athleteId],
    ),
    metrics: metrics.map((m) => m.identifier).sort(),
    sleepNights: hasTable('health_sleep_nights')
      ? count(db, "SELECT COUNT(*) AS n FROM health_sleep_nights WHERE athlete_id = ? AND kind = 'night'", [
          athleteId,
        ])
      : 0,
    ecgCount: count(db, 'SELECT COUNT(*) AS n FROM ecg_readings WHERE athlete_id = ?', [athleteId]),
    rings: !!get(db, 'SELECT 1 FROM activity_summaries WHERE athlete_id = ? LIMIT 1', [athleteId]),
  };
}
