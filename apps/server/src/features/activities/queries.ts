import {
  SPORTS,
  defaultWorkoutName,
  sportInfo,
  type TimeOfDay,
  type ActivitiesSummary,
  type ActivityListItem,
  type ActivityListPage,
  type ActivityMedal,
  type ActivityNav,
  type ActivityNeighbor,
  type ActivitySimilar,
  type ActivitySimilarItem,
  type ActivitySort,
  type ActivitySportTotals,
  type ActivityTotals,
  type ActivityWeekDay,
} from '@cadence/shared';
import { all, get, type Db } from '../../db/db';
import { SUMMARY_COLS, toSummary, type WorkoutRow } from '../../core/workouts';
import { haversine } from '../../lib/geo';
import { dayString, parseDay } from '../../lib/time';

// ---------------------------------------------------------------------------
// List (feed + activities page)
// ---------------------------------------------------------------------------

export interface ListFilter {
  sport?: string;
  from?: number;
  to?: number;
  q?: string;
  hasRoute?: boolean;
  includeHidden?: boolean;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Local hour ranges [from, to) of the default-name time of day (see timeOfDay in @cadence/shared). */
const TOD_HOURS: Record<TimeOfDay, [number, number][]> = {
  morning: [[4, 11]],
  lunch: [[11, 14]],
  afternoon: [[14, 17]],
  evening: [[17, 21]],
  night: [
    [21, 24],
    [0, 4],
  ],
};
const TODS = Object.keys(TOD_HOURS) as TimeOfDay[];
/** A representative local hour per time of day, to build the default names. */
const TOD_SAMPLE_HOUR: Record<TimeOfDay, number> = { morning: 8, lunch: 12, afternoon: 15, evening: 18, night: 22 };

/**
 * Unnamed workouts are shown with a localized default name ("Morning Run" / "Lauf am Morgen"). For a search term,
 * returns per time of day the sports whose default name (English or German) contains it.
 */
export function defaultNameMatches(q: string): Map<TimeOfDay, string[]> {
  const s = q.trim().toLowerCase();
  const out = new Map<TimeOfDay, string[]>();
  if (s.length < 2) return out;
  for (const tod of TODS) {
    const ts = TOD_SAMPLE_HOUR[tod] * 3600;
    const sports = Object.keys(SPORTS).filter((sport) =>
      (['en', 'de'] as const).some((lang) => defaultWorkoutName(sport, ts, 0, lang).toLowerCase().includes(s)) ||
      sport.includes(s),
    );
    if (sports.length) out.set(tod, sports);
  }
  return out;
}

const LOCAL_HOUR = '(((start_ts + tz_min * 60) % 86400 + 86400) % 86400) / 3600';

/** WHERE clause over `workouts` (unaliased) for a list filter; duplicates are always excluded. */
export function listWhere(athleteId: number, f: ListFilter): { sql: string; params: unknown[] } {
  const where = ['athlete_id = ?', 'duplicate_of IS NULL'];
  const params: unknown[] = [athleteId];
  if (!f.includeHidden) where.push('hidden = 0');
  const sports = (f.sport ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (sports.length) {
    where.push(`sport IN (${sports.map(() => '?').join(',')})`);
    params.push(...sports);
  }
  if (f.from !== undefined) {
    where.push('start_ts >= ?');
    params.push(f.from);
  }
  if (f.to !== undefined) {
    where.push('start_ts < ?');
    params.push(f.to);
  }
  if (f.hasRoute !== undefined) {
    where.push('has_route = ?');
    params.push(f.hasRoute ? 1 : 0);
  }
  const q = f.q?.trim();
  if (q) {
    const like = `%${escapeLike(q)}%`;
    const ors = [`name LIKE ? ESCAPE '\\'`, `notes LIKE ? ESCAPE '\\'`, `source_name LIKE ? ESCAPE '\\'`];
    params.push(like, like, like);
    const allSports = Object.keys(SPORTS).length;
    for (const [tod, sports] of defaultNameMatches(q)) {
      const hours = TOD_HOURS[tod].map(([a, b]) => `(${LOCAL_HOUR} >= ${a} AND ${LOCAL_HOUR} < ${b})`).join(' OR ');
      if (sports.length === allSports) ors.push(`(name = '' AND (${hours}))`);
      else {
        ors.push(`(name = '' AND (${hours}) AND sport IN (${sports.map(() => '?').join(',')}))`);
        params.push(...sports);
      }
    }
    where.push(`(${ors.join(' OR ')})`);
  }
  return { sql: where.join(' AND '), params };
}

export const SORT_EXPR: Record<ActivitySort, string> = {
  start: 'start_ts',
  distance: 'distance_m',
  time: 'COALESCE(moving_s, duration_s)',
  pace: 'avg_speed',
  elevation: 'elevation_gain_m',
  hr: 'avg_hr',
  effort: 'effort',
};

const emptyTotals = (): ActivityTotals => ({ count: 0, distanceM: 0, movingS: 0, elevationM: 0, energyKcal: 0, effort: 0 });

/** Medals (current rank 1–3 among visible workouts) of the given workouts, one query for all of them. */
export function medalsFor(db: Db, athleteId: number, ids: number[]): Map<number, ActivityMedal[]> {
  const out = new Map<number, ActivityMedal[]>();
  if (!ids.length) return out;
  // One ranking pass over the (sport, effort) groups that occur on this page — same order as core's
  // bestEffortsOf (elapsed time, then workout id), among visible workouts.
  const rows = all<{ workout_id: number; effort: string; distance_m: number; elapsed_s: number; rank: number }>(
    db,
    `WITH page AS (
       SELECT DISTINCT sport, effort FROM best_efforts WHERE workout_id IN (${ids.map(() => '?').join(',')})
     ), ranked AS (
       SELECT be.workout_id, be.effort, be.distance_m, be.elapsed_s,
              ROW_NUMBER() OVER (PARTITION BY be.sport, be.effort ORDER BY be.elapsed_s, be.workout_id) AS rank
       FROM best_efforts be
       JOIN page p ON p.sport = be.sport AND p.effort = be.effort
       JOIN workouts w ON w.id = be.workout_id
       WHERE be.athlete_id = ? AND w.hidden = 0 AND w.duplicate_of IS NULL
     )
     SELECT workout_id, effort, distance_m, elapsed_s, rank FROM ranked
     WHERE rank <= 3 AND workout_id IN (${ids.map(() => '?').join(',')})`,
    [...ids, athleteId, ...ids],
  );
  for (const r of rows) {
    if (r.rank > 3) continue;
    const list = out.get(r.workout_id) ?? [];
    list.push({ effort: r.effort, distanceM: r.distance_m, elapsedS: r.elapsed_s, rank: r.rank as 1 | 2 | 3 });
    out.set(r.workout_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.rank - b.rank || b.distanceM - a.distanceM);
  return out;
}

export interface ListOptions extends ListFilter {
  sort: ActivitySort;
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export function listActivities(db: Db, athleteId: number, o: ListOptions): ActivityListPage {
  const { sql, params } = listWhere(athleteId, o);
  const t = get<{
    n: number;
    dist: number | null;
    mov: number | null;
    ele: number | null;
    kcal: number | null;
    effort: number | null;
  }>(
    db,
    `SELECT COUNT(*) AS n, SUM(distance_m) AS dist, SUM(COALESCE(moving_s, duration_s)) AS mov,
            SUM(elevation_gain_m) AS ele, SUM(energy_kcal) AS kcal, SUM(effort) AS effort
     FROM workouts WHERE ${sql}`,
    params,
  )!;
  const expr = SORT_EXPR[o.sort];
  const dir = o.order === 'asc' ? 'ASC' : 'DESC';
  const rows = all<WorkoutRow>(
    db,
    `SELECT ${SUMMARY_COLS} FROM workouts WHERE ${sql}
     ORDER BY (${expr}) IS NULL, ${expr} ${dir}, start_ts ${dir}, id ${dir} LIMIT ? OFFSET ?`,
    [...params, o.limit, o.offset],
  );
  const medals = medalsFor(
    db,
    athleteId,
    rows.map((r) => r.id),
  );
  const items: ActivityListItem[] = rows.map((r) => ({ ...toSummary(r), medals: medals.get(r.id) ?? [] }));
  return {
    items,
    total: t.n,
    limit: o.limit,
    offset: o.offset,
    totals: {
      count: t.n,
      distanceM: t.dist ?? 0,
      movingS: t.mov ?? 0,
      elevationM: t.ele ?? 0,
      energyKcal: t.kcal ?? 0,
      effort: t.effort ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Dashboard summary (from daily_activity: hidden + duplicates already excluded)
// ---------------------------------------------------------------------------

interface DailyRow {
  sport: string;
  count: number;
  distance_m: number;
  moving_s: number;
  elevation_m: number;
  energy_kcal: number;
  effort: number;
}

const DAILY_SUMS = `SUM(count) AS count, SUM(distance_m) AS distance_m, SUM(moving_s) AS moving_s,
  SUM(elevation_m) AS elevation_m, SUM(energy_kcal) AS energy_kcal, SUM(effort) AS effort`;

function toTotals(r: Partial<DailyRow> | undefined): ActivityTotals {
  return {
    count: r?.count ?? 0,
    distanceM: r?.distance_m ?? 0,
    movingS: r?.moving_s ?? 0,
    elevationM: r?.elevation_m ?? 0,
    energyKcal: r?.energy_kcal ?? 0,
    effort: r?.effort ?? 0,
  };
}

function addTotals(a: ActivityTotals, b: ActivityTotals): ActivityTotals {
  return {
    count: a.count + b.count,
    distanceM: a.distanceM + b.distanceM,
    movingS: a.movingS + b.movingS,
    elevationM: a.elevationM + b.elevationM,
    energyKcal: a.energyKcal + b.energyKcal,
    effort: a.effort + b.effort,
  };
}

/** Weekday of an epoch day number: 0 = Sunday … 6 = Saturday (1970-01-01 was a Thursday). */
export const weekdayOf = (epochDay: number): number => (((epochDay + 4) % 7) + 7) % 7;

/** First day of the week containing `day` (weekStart 1 = Monday, 0 = Sunday). */
export function weekStartOf(day: string, weekStart: 0 | 1): string {
  const d = parseDay(day)!;
  return dayString(d - ((weekdayOf(d) - weekStart + 7) % 7));
}

export function activitySummary(db: Db, athleteId: number, today: string, weekStart: 0 | 1): ActivitiesSummary {
  const todayN = parseDay(today)!;
  const weekStartDay = weekStartOf(today, weekStart);
  const ws = parseDay(weekStartDay)!;
  const weekEnd = dayString(ws + 6);
  const yearStartDay = `${today.slice(0, 4)}-01-01`;
  const lastWeekStart = dayString(ws - 7);
  const lastWeekEnd = dayString(ws - 1);

  const bySport = (fromDay: string, toDay: string) =>
    new Map(
      all<DailyRow>(
        db,
        `SELECT sport, ${DAILY_SUMS} FROM daily_activity WHERE athlete_id = ? AND day >= ? AND day <= ? GROUP BY sport`,
        [athleteId, fromDay, toDay],
      ).map((r) => [r.sport, toTotals(r)]),
    );
  const allTime = bySport('0000-00-00', '9999-12-31');
  const year = bySport(yearStartDay, `${today.slice(0, 4)}-12-31`);
  const week = bySport(weekStartDay, weekEnd);
  const lastWeek = get<DailyRow>(
    db,
    `SELECT ${DAILY_SUMS} FROM daily_activity WHERE athlete_id = ? AND day >= ? AND day <= ?`,
    [athleteId, lastWeekStart, lastWeekEnd],
  );
  const sum = (m: Map<string, ActivityTotals>) => [...m.values()].reduce(addTotals, emptyTotals());

  const sports: ActivitySportTotals[] = [...allTime.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([sport, totals]) => ({
      sport,
      allTime: totals,
      thisYear: year.get(sport) ?? emptyTotals(),
      thisWeek: week.get(sport) ?? emptyTotals(),
    }));

  const dayRows = all<DailyRow & { day: string }>(
    db,
    `SELECT day, sport, count, distance_m, moving_s, elevation_m, energy_kcal, effort
     FROM daily_activity WHERE athlete_id = ? AND day >= ? AND day <= ? ORDER BY day, sport`,
    [athleteId, weekStartDay, weekEnd],
  );
  const days: ActivityWeekDay[] = Array.from({ length: 7 }, (_, i) => ({
    day: dayString(ws + i),
    totals: emptyTotals(),
    sports: [],
  }));
  for (const r of dayRows) {
    const d = days[(parseDay(r.day) ?? ws) - ws];
    if (!d) continue;
    d.totals = addTotals(d.totals, toTotals(r));
    d.sports.push({ sport: r.sport, count: r.count, movingS: r.moving_s, distanceM: r.distance_m });
  }

  const athlete = get<{ name: string }>(db, 'SELECT name FROM athletes WHERE id = ?', [athleteId]);
  const range = get<{ first: number | null; last: number | null }>(
    db,
    'SELECT MIN(start_ts) AS first, MAX(start_ts) AS last FROM workouts WHERE athlete_id = ? AND hidden = 0 AND duplicate_of IS NULL',
    [athleteId],
  );
  // PRs (still the best) set during the last 30 days
  const since = (todayN - 29) * 86400 - 14 * 3600;
  const recent = all<{ workout_id: number }>(
    db,
    `SELECT be.workout_id FROM best_efforts be JOIN workouts w ON w.id = be.workout_id
     WHERE be.athlete_id = ? AND be.start_ts >= ? AND w.hidden = 0 AND w.duplicate_of IS NULL
       AND NOT EXISTS (SELECT 1 FROM best_efforts b2 JOIN workouts w2 ON w2.id = b2.workout_id
            WHERE b2.athlete_id = be.athlete_id AND b2.sport = be.sport AND b2.effort = be.effort
              AND w2.hidden = 0 AND w2.duplicate_of IS NULL
              AND (b2.elapsed_s < be.elapsed_s OR (b2.elapsed_s = be.elapsed_s AND b2.workout_id < be.workout_id)))`,
    [athleteId, since],
  );

  return {
    athleteName: athlete?.name ?? '',
    today,
    weekStartDay,
    yearStartDay,
    allTime: sum(allTime),
    thisYear: sum(year),
    thisWeek: sum(week),
    lastWeek: toTotals(lastWeek),
    sports,
    week: days,
    firstActivityTs: range?.first ?? null,
    lastActivityTs: range?.last ?? null,
    recentPrs: recent.length,
  };
}

// ---------------------------------------------------------------------------
// Previous / next
// ---------------------------------------------------------------------------

export function activityNav(db: Db, athleteId: number, id: number): ActivityNav | null {
  const w = get<{ start_ts: number }>(db, 'SELECT start_ts FROM workouts WHERE id = ? AND athlete_id = ?', [id, athleteId]);
  if (!w) return null;
  type Row = { id: number; name: string; sport: string; start_ts: number; tz_min: number };
  const pick = (r: Row | undefined): ActivityNeighbor | null =>
    r ? { id: r.id, name: r.name, sport: r.sport, startTs: r.start_ts, tzMin: r.tz_min } : null;
  const cols = 'id, name, sport, start_ts, tz_min';
  const base = 'athlete_id = ? AND hidden = 0 AND duplicate_of IS NULL AND id <> ?';
  const prev = get<Row>(
    db,
    `SELECT ${cols} FROM workouts WHERE ${base} AND (start_ts < ? OR (start_ts = ? AND id < ?))
     ORDER BY start_ts DESC, id DESC LIMIT 1`,
    [athleteId, id, w.start_ts, w.start_ts, id],
  );
  const next = get<Row>(
    db,
    `SELECT ${cols} FROM workouts WHERE ${base} AND (start_ts > ? OR (start_ts = ? AND id > ?))
     ORDER BY start_ts ASC, id ASC LIMIT 1`,
    [athleteId, id, w.start_ts, w.start_ts, id],
  );
  return { prev: pick(prev), next: pick(next) };
}

// ---------------------------------------------------------------------------
// Similar activities
// ---------------------------------------------------------------------------

interface SimilarRow {
  id: number;
  name: string;
  sport: string;
  start_ts: number;
  tz_min: number;
  distance_m: number | null;
  moving_s: number | null;
  duration_s: number;
  avg_speed: number | null;
  avg_hr: number | null;
  elevation_gain_m: number | null;
  effort: number | null;
  start_lat: number | null;
  start_lon: number | null;
  end_lat: number | null;
  end_lon: number | null;
  efficiency: number | null;
  gap_speed: number | null;
}

const SIMILAR_COLS = `w.id, w.name, w.sport, w.start_ts, w.tz_min, w.distance_m, w.moving_s, w.duration_s, w.avg_speed,
  w.avg_hr, w.elevation_gain_m, w.effort, w.start_lat, w.start_lon, w.end_lat, w.end_lon,
  a.efficiency AS efficiency, a.gap_speed AS gap_speed`;

/** Same start and finish within `radiusM` and distance within ±10 %. */
export function sameRoute(a: SimilarRow, b: SimilarRow, radiusM = 300): boolean {
  if (
    a.start_lat === null ||
    a.start_lon === null ||
    a.end_lat === null ||
    a.end_lon === null ||
    b.start_lat === null ||
    b.start_lon === null ||
    b.end_lat === null ||
    b.end_lon === null ||
    !a.distance_m ||
    !b.distance_m
  )
    return false;
  if (Math.abs(b.distance_m / a.distance_m - 1) > 0.1) return false;
  return (
    haversine(a.start_lat, a.start_lon, b.start_lat, b.start_lon) <= radiusM &&
    haversine(a.end_lat, a.end_lon, b.end_lat, b.end_lon) <= radiusM
  );
}

/** Rank (1-based) of `id` in `items` sorted by `value` descending; null when it has no value. */
function rankBy<T extends { id: number }>(items: T[], id: number, value: (x: T) => number | null): number | null {
  const own = items.find((x) => x.id === id);
  const v = own ? value(own) : null;
  if (v === null || v === undefined) return null;
  return 1 + items.filter((x) => x.id !== id && (value(x) ?? -Infinity) > v).length;
}

export function similarActivities(db: Db, athleteId: number, id: number, limit = 250): ActivitySimilar | null {
  const cur = get<SimilarRow>(
    db,
    `SELECT ${SIMILAR_COLS} FROM workouts w LEFT JOIN activities_analysis a ON a.workout_id = w.id
     WHERE w.id = ? AND w.athlete_id = ?`,
    [id, athleteId],
  );
  if (!cur) return null;
  const byDistance = sportInfo(cur.sport).distance && (cur.distance_m ?? 0) >= 200 && cur.avg_speed !== null;
  const basis: ActivitySimilar['basis'] = byDistance ? 'distance' : 'duration';
  const ref = byDistance ? cur.distance_m! : cur.duration_s;
  const min = ref * (byDistance ? 0.85 : 0.75);
  const max = ref * (byDistance ? 1.15 : 1.25);
  const col = byDistance ? 'w.distance_m' : 'w.duration_s';
  const rows = all<SimilarRow>(
    db,
    `SELECT ${SIMILAR_COLS} FROM workouts w LEFT JOIN activities_analysis a ON a.workout_id = w.id
     WHERE w.athlete_id = ? AND w.sport = ? AND w.hidden = 0 AND w.duplicate_of IS NULL AND w.id <> ?
       AND ${col} BETWEEN ? AND ? ${byDistance ? 'AND w.avg_speed IS NOT NULL' : ''}
     ORDER BY w.start_ts DESC LIMIT ?`,
    [athleteId, cur.sport, id, min, max, limit],
  );
  const toItem = (r: SimilarRow, current: boolean): ActivitySimilarItem => ({
    id: r.id,
    name: r.name,
    sport: r.sport,
    startTs: r.start_ts,
    tzMin: r.tz_min,
    distanceM: r.distance_m,
    movingS: r.moving_s,
    durationS: r.duration_s,
    avgSpeed: r.avg_speed,
    gapSpeed: r.gap_speed,
    avgHr: r.avg_hr,
    elevationGainM: r.elevation_gain_m,
    effort: r.effort,
    efficiency: r.efficiency,
    sameRoute: current || sameRoute(cur, r),
    current,
  });
  const items = [...rows.map((r) => toItem(r, false)), toItem(cur, true)].sort((a, b) => a.startTs - b.startTs || a.id - b.id);
  const value = (x: ActivitySimilarItem) => (byDistance ? x.avgSpeed : x.effort);
  const route = items.filter((x) => x.sameRoute);
  return {
    workoutId: id,
    sport: cur.sport,
    basis,
    min,
    max,
    items,
    rank: rankBy(items, id, value),
    count: items.length,
    routeRank: route.length > 1 ? rankBy(route, id, value) : null,
    routeCount: route.length,
  };
}
