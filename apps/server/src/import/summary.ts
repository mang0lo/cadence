import type { ImportHighlight, ImportSummary, ImportSummaryWorkout } from '@cadence/shared';
import { all, get, type Db } from '../db/db';
import { features } from '../features';
import { placeNameAt } from '../lib/places';
import { localDay } from '../lib/time';

/** Highlights per feature at most (a long first import must not bloat every job row). */
const MAX_HIGHLIGHTS_PER_FEATURE = 24;

interface NewRow {
  id: number;
  name: string;
  sport: string;
  start_ts: number;
  tz_min: number;
  distance_m: number | null;
  time_s: number;
  start_lat: number | null;
  start_lon: number | null;
}

/**
 * "What's new" of an import: the new visible activities by sport, the newest ones, and what every feature module
 * found noteworthy about them (records, trophies, explorer tiles …). Never throws: a failing feature only loses its
 * highlights.
 */
export function importSummary(
  db: Db,
  athleteId: number,
  newWorkoutIds: number[],
  since: number,
  log: (message: string) => void = () => {},
): ImportSummary {
  const rows: NewRow[] = [];
  // chunks keep the statement below SQLite's parameter limit for a first import of many thousand workouts
  for (let i = 0; i < newWorkoutIds.length; i += 500) {
    const ids = newWorkoutIds.slice(i, i + 500);
    rows.push(
      ...all<NewRow>(
        db,
        `SELECT id, name, sport, start_ts, tz_min, distance_m, COALESCE(NULLIF(moving_s, 0), duration_s) AS time_s,
                start_lat, start_lon
         FROM workouts
         WHERE athlete_id = ? AND hidden = 0 AND duplicate_of IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
        [athleteId, ...ids],
      ),
    );
  }
  rows.sort((a, b) => a.start_ts - b.start_ts || a.id - b.id);
  const total = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM workouts WHERE athlete_id = ?', [athleteId])!.n;
  const initial = newWorkoutIds.length > 0 && newWorkoutIds.length >= total;

  const bySport = new Map<string, ImportSummary['sports'][number]>();
  for (const r of rows) {
    const s = bySport.get(r.sport) ?? { sport: r.sport, count: 0, distanceM: 0, movingS: 0 };
    s.count++;
    s.distanceM += r.distance_m ?? 0;
    s.movingS += r.time_s;
    bySport.set(r.sport, s);
  }
  const latest: ImportSummaryWorkout[] = rows
    .slice(-5)
    .reverse()
    .map((r) => ({
      id: r.id,
      name: r.name,
      sport: r.sport,
      startTs: r.start_ts,
      tzMin: r.tz_min,
      distanceM: r.distance_m,
      movingS: r.time_s,
      place: placeNameAt(r.start_lat, r.start_lon),
    }));

  const highlights: ImportHighlight[] = [];
  if (rows.length)
    for (const f of features) {
      if (!f.whatsNew) continue;
      try {
        const items = f.whatsNew({ db, athleteId, workoutIds: rows.map((r) => r.id), since, initial });
        highlights.push(...items.slice(0, MAX_HIGHLIGHTS_PER_FEATURE).map((h) => ({ ...h, feature: f.name })));
      } catch (e) {
        log(`What's new of ${f.name} failed: ${(e as Error).message}`);
      }
    }

  // titles for the activities the highlights point to
  const refIds = [...new Set(highlights.flatMap((h) => (h.workoutId !== null ? [h.workoutId] : [])))];
  if (refIds.length) {
    const refs = new Map(
      all<{ id: number; name: string; sport: string; start_ts: number; tz_min: number }>(
        db,
        'SELECT id, name, sport, start_ts, tz_min FROM workouts WHERE athlete_id = ? AND id IN (SELECT value FROM json_each(?))',
        [athleteId, JSON.stringify(refIds)],
      ).map((r) => [r.id, { id: r.id, name: r.name, sport: r.sport, startTs: r.start_ts, tzMin: r.tz_min }]),
    );
    for (const h of highlights) h.workout = h.workoutId !== null ? (refs.get(h.workoutId) ?? null) : null;
  }

  return {
    count: rows.length,
    initial,
    sports: [...bySport.values()].sort((a, b) => b.count - a.count || b.movingS - a.movingS),
    fromDay: rows.length ? localDay(rows[0]!.start_ts, rows[0]!.tz_min) : null,
    toDay: rows.length ? localDay(rows[rows.length - 1]!.start_ts, rows[rows.length - 1]!.tz_min) : null,
    latest,
    highlights,
  };
}
