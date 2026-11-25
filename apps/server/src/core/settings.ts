import {
  DEFAULT_SETTINGS,
  HR_ZONE_FRACTIONS,
  type Athlete,
  type AthleteSettings,
  type EffectiveHr,
} from '@cadence/shared';
import { all, get, json, run, type Db } from '../db/db';
import { heartMetric } from './sources';

/** Generic per-athlete JSON setting (features use namespaced keys like 'consistency.goals'). */
export function getSetting<T>(db: Db, athleteId: number, key: string, fallback: T): T {
  const row = get<{ value: string }>(db, 'SELECT value FROM settings WHERE athlete_id = ? AND key = ?', [
    athleteId,
    key,
  ]);
  return row ? json<T>(row.value, fallback) : fallback;
}

export function setSetting(db: Db, athleteId: number, key: string, value: unknown): void {
  run(
    db,
    `INSERT INTO settings (athlete_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (athlete_id, key) DO UPDATE SET value = excluded.value`,
    [athleteId, key, JSON.stringify(value)],
  );
}

const SETTINGS_KEY = 'core.settings';

export function getSettings(db: Db, athleteId: number): AthleteSettings {
  return { ...DEFAULT_SETTINGS, ...getSetting<Partial<AthleteSettings>>(db, athleteId, SETTINGS_KEY, {}) };
}

/**
 * Stores only the keys the athlete set, never the defaults: a key that is missing means "not chosen" (the first
 * COROS connection picks the watch then), and a changed default reaches everyone who did not choose.
 */
export function updateSettings(db: Db, athleteId: number, patch: Partial<AthleteSettings>): AthleteSettings {
  const next = { ...getSetting<Partial<AthleteSettings>>(db, athleteId, SETTINGS_KEY, {}), ...patch };
  setSetting(db, athleteId, SETTINGS_KEY, next);
  return { ...DEFAULT_SETTINGS, ...next };
}

export function ageFrom(birthDate: string | null, at = new Date()): number | null {
  if (!birthDate || !/^\d{4}-\d{2}-\d{2}/.test(birthDate)) return null;
  const [y, m, d] = birthDate.slice(0, 10).split('-').map(Number) as [number, number, number];
  let age = at.getUTCFullYear() - y;
  if (at.getUTCMonth() + 1 < m || (at.getUTCMonth() + 1 === m && at.getUTCDate() < d)) age--;
  return age >= 0 && age < 130 ? age : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Max / resting heart rate and zone bounds actually used for analytics.
 * Explicit settings win; otherwise they are derived from the data (robust observed max, recent median
 * resting HR), then from age (Tanaka: 208 − 0.7·age), then sane defaults.
 */
export function getEffectiveHr(db: Db, athleteId: number): EffectiveHr {
  const settings = getSettings(db, athleteId);
  const athlete = get<{ birth_date: string | null }>(db, 'SELECT birth_date FROM athletes WHERE id = ?', [athleteId]);
  const age = ageFrom(settings.birthDate ?? athlete?.birth_date ?? null);

  let maxHr: number;
  let maxHrSource: EffectiveHr['maxHrSource'];
  if (settings.maxHr) {
    maxHr = settings.maxHr;
    maxHrSource = 'settings';
  } else {
    // 3rd highest workout max HR ignores the odd optical-sensor spike.
    const top = all<{ max_hr: number }>(
      db,
      `SELECT max_hr FROM workouts WHERE athlete_id = ? AND max_hr BETWEEN 120 AND 225 AND duplicate_of IS NULL
       ORDER BY max_hr DESC LIMIT 3`,
      [athleteId],
    );
    if (top.length === 3) {
      maxHr = Math.round(top[2]!.max_hr);
      maxHrSource = 'observed';
    } else if (age !== null) {
      maxHr = Math.round(208 - 0.7 * age);
      maxHrSource = 'age';
    } else {
      maxHr = 190;
      maxHrSource = 'default';
    }
  }

  let restingHr: number;
  let restingHrSource: EffectiveHr['restingHrSource'];
  if (settings.restingHr) {
    restingHr = settings.restingHr;
    restingHrSource = 'settings';
  } else {
    const recent = all<{ value: number }>(
      db,
      `SELECT value FROM daily_metrics WHERE athlete_id = ? AND metric = ?
       ORDER BY day DESC LIMIT 90`,
      [athleteId, heartMetric(db, athleteId, 'restingHr', settings)],
    ).map((r) => r.value);
    const m = median(recent);
    if (m !== null && m > 25 && m < 120) {
      restingHr = Math.round(m);
      restingHrSource = 'observed';
    } else {
      restingHr = 60;
      restingHrSource = 'default';
    }
  }

  let zoneBounds: number[];
  let method = settings.hrZoneMethod;
  const custom = settings.hrZones;
  if (method === 'custom' && custom && custom.length === 4 && custom.every((v, i) => i === 0 || v > custom[i - 1]!)) {
    zoneBounds = [...custom];
  } else {
    if (method === 'custom') method = 'maxhr';
    zoneBounds = HR_ZONE_FRACTIONS.map((f) =>
      Math.round(method === 'hrr' ? restingHr + f * (maxHr - restingHr) : f * maxHr),
    );
  }

  return { maxHr, restingHr, method, zoneBounds, maxHrSource, restingHrSource };
}

/** Zone index 0..4 for a heart rate given upper bounds of Z1..Z4. */
export function hrZoneIndex(hr: number, zoneBounds: number[]): number {
  for (let i = 0; i < zoneBounds.length; i++) if (hr < zoneBounds[i]!) return i;
  return zoneBounds.length;
}

export function getAthlete(db: Db, athleteId: number): Athlete {
  const row = get<{
    id: number;
    name: string;
    birth_date: string | null;
    sex: string | null;
    blood_type: string | null;
    skin_type: string | null;
  }>(db, 'SELECT id, name, birth_date, sex, blood_type, skin_type FROM athletes WHERE id = ?', [athleteId]);
  if (!row) throw new Error(`Athlete ${athleteId} not found`);
  const settings = getSettings(db, athleteId);
  const range = get<{ first: number | null; last: number | null }>(
    db,
    'SELECT MIN(start_ts) AS first, MAX(start_ts) AS last FROM workouts WHERE athlete_id = ? AND hidden = 0',
    [athleteId],
  );
  const birthDate = settings.birthDate ?? row.birth_date;
  const sex = (settings.sex ?? row.sex) as Athlete['sex'];
  return {
    id: row.id,
    name: row.name,
    birthDate,
    sex,
    bloodType: row.blood_type,
    skinType: row.skin_type,
    age: ageFrom(birthDate),
    hr: getEffectiveHr(db, athleteId),
    firstActivityTs: range?.first ?? null,
    lastActivityTs: range?.last ?? null,
  };
}
