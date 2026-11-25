/**
 * Trophies: the derive step evaluates the catalog against the full history and caches the results in
 * consistency_achievements (with the day + activity that earned each one). Reads recompute lazily when the
 * cache is missing or was written by an older rule version. Monthly challenges are computed on the fly.
 * The cache's state (rule version, week start) lives in the setting consistency.achievementsMeta, which a data reset
 * removes together with the rows (Feature.onReset).
 */
import {
  ACHIEVEMENT_TIERS,
  type Achievement,
  type AchievementGroup,
  type AchievementKind,
  type AchievementTier,
  type ChallengeMonth,
  type TrophiesResponse,
  type WorkoutStatistic,
} from '@cadence/shared';
import { all, get, json, run, tx, type Db } from '../../db/db';
import { getSetting, setSetting } from '../../core/settings';
import type { DeriveContext, DeriveStep } from '../types';
import { localDay, nowSec } from '../../lib/time';
import { ACHIEVEMENTS_VERSION, buildCatalog, evaluateAchievements, type EvalInput, type EvalWorkout } from './achievements';
import { CHALLENGES, computeChallenges, type ChallengeWorkout } from './challenges';
import { loadRings, loadWorkouts, resolveDays, ringFractions, weekStartOfAthlete } from './data';
import { daysBetween, daysInMonth, localParts, monthEndOf } from './days';

const META_KEY = 'consistency.achievementsMeta';
/** An achievement counts as "new" for this long after an import first found it. */
const NEW_WINDOW_S = 14 * 86400;

interface History {
  input: EvalInput;
  sports: string[];
  hasRings: boolean;
  challengeWorkouts: ChallengeWorkout[];
}

/** Visible workouts as input of the monthly challenges (sport, local day, distance, elevation). */
function loadChallengeWorkouts(db: Db, athleteId: number): ChallengeWorkout[] {
  return loadWorkouts(db, athleteId).map((w) => ({
    id: w.id,
    sport: w.sport,
    day: localDay(w.start_ts, w.tz_min),
    distanceM: w.distance_m ?? 0,
    elevationM: w.elevation_gain_m ?? 0,
  }));
}

/** Swim / bike / run legs of visible multisport workouts (triathlons) with the distance of each leg. */
function loadLegs(db: Db, athleteId: number): EvalWorkout[] {
  const rows = all<{ workout_id: number; sport: string; start_ts: number; tz_min: number; stats: string | null }>(
    db,
    `SELECT a.workout_id, a.sport, a.start_ts, w.tz_min, a.stats FROM workout_activities a
     JOIN workouts w ON w.id = a.workout_id
     WHERE w.athlete_id = ? AND w.hidden = 0 AND w.duplicate_of IS NULL AND w.sport = 'multisport'
     ORDER BY a.start_ts, a.workout_id, a.idx`,
    [athleteId],
  );
  const out: EvalWorkout[] = [];
  for (const r of rows) {
    const stats = json<WorkoutStatistic[]>(r.stats, []);
    const distanceM = stats.find((s) => s.type.startsWith('HKQuantityTypeIdentifierDistance') && s.sum)?.sum ?? 0;
    if (!(distanceM > 0)) continue;
    const p = localParts(r.start_ts, r.tz_min);
    out.push({
      id: r.workout_id,
      sport: r.sport,
      startTs: r.start_ts,
      day: p.day,
      weekday: p.weekday,
      hour: p.hour,
      distanceM,
      elevationM: 0,
    });
  }
  return out;
}

function loadHistory(db: Db, athleteId: number): History {
  const workouts = loadWorkouts(db, athleteId).map((w) => {
    const p = localParts(w.start_ts, w.tz_min);
    return {
      id: w.id,
      sport: w.sport,
      startTs: w.start_ts,
      day: p.day,
      weekday: p.weekday,
      hour: p.hour,
      distanceM: w.distance_m ?? 0,
      elevationM: w.elevation_gain_m ?? 0,
    };
  });
  const rings = loadRings(db, athleteId).map((r) => ({ day: r.day, ...ringFractions(r) }));
  return {
    input: { workouts, legs: loadLegs(db, athleteId), rings, weekStart: weekStartOfAthlete(db, athleteId), challengeDays: [] },
    sports: [...new Set(workouts.map((w) => w.sport))],
    hasRings: rings.length > 0,
    challengeWorkouts: workouts.map((w) => ({
      id: w.id,
      sport: w.sport,
      day: w.day,
      distanceM: w.distanceM,
      elevationM: w.elevationM,
    })),
  };
}

/** Challenge results for every month from the first activity to asOf's month (oldest first). */
function challengeMonths(workouts: ChallengeWorkout[], asOf: string): ChallengeMonth[] {
  const last = asOf.slice(0, 7);
  const first = workouts.reduce((m, w) => (w.day.slice(0, 7) < m ? w.day.slice(0, 7) : m), last);
  return computeChallenges(workouts, first, last);
}

export interface RecomputeResult {
  total: number;
  earned: number;
  newlyEarned: number;
}

/**
 * Evaluate and store all achievements of an athlete. Trophies earned since the previous computation are stamped
 * as new (first_seen_at), except on an initial computation: no cache yet (first import, after a data reset), a
 * changed rule version, or `initial` set by the caller (the first import, a changed week start). Those only repeat
 * the history; nothing there is news.
 */
export function recomputeAchievements(
  db: Db,
  athleteId: number,
  now = nowSec(),
  o: { initial?: boolean } = {},
): RecomputeResult {
  const h = loadHistory(db, athleteId);
  const { asOf } = resolveDays(db, athleteId);
  h.input.challengeDays = challengeMonths(h.challengeWorkouts, asOf).flatMap((m) =>
    m.items.flatMap((i) => (i.completedDay ? [i.completedDay] : [])),
  );
  const catalog = buildCatalog({ sports: h.sports, hasRings: h.hasRings });
  const results = evaluateAchievements(catalog, h.input);
  const meta = getSetting<{ version?: number } | null>(db, athleteId, META_KEY, null);
  let earned = 0;
  let newlyEarned = 0;
  tx(db, () => {
    const prev = new Map(
      all<{ key: string; earned_day: string | null; first_seen_at: number | null }>(
        db,
        'SELECT key, earned_day, first_seen_at FROM consistency_achievements WHERE athlete_id = ?',
        [athleteId],
      ).map((r) => [r.key, r]),
    );
    const initial = !!o.initial || !meta || meta.version !== ACHIEVEMENTS_VERSION || prev.size === 0;
    run(db, 'DELETE FROM consistency_achievements WHERE athlete_id = ?', [athleteId]);
    catalog.forEach((d, i) => {
      const r = results[i]!;
      const before = prev.get(d.key);
      let firstSeen: number | null = null;
      if (r.earnedDay) {
        earned++;
        if (before?.earned_day) firstSeen = before.first_seen_at;
        else if (!initial) {
          firstSeen = now;
          newlyEarned++;
        }
      }
      run(
        db,
        `INSERT INTO consistency_achievements
           (athlete_id, key, grp, kind, tier, sport, threshold, name, ord, progress, earned_day, workout_id, first_seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          athleteId,
          d.key,
          d.group,
          d.kind,
          d.tier,
          d.sport,
          d.threshold,
          d.name,
          i,
          r.progress,
          r.earnedDay,
          r.workoutId,
          firstSeen,
          now,
        ],
      );
    });
    setSetting(db, athleteId, META_KEY, { version: ACHIEVEMENTS_VERSION, computedAt: now, weekStart: h.input.weekStart });
  });
  return { total: catalog.length, earned, newlyEarned };
}

/**
 * Recompute when the cache is missing or stale (older rules, never derived, other week start). Trophies that only
 * appear because of that are not news: nothing is flagged new.
 */
export function ensureAchievements(db: Db, athleteId: number): void {
  const meta = getSetting<{ version?: number; weekStart?: number } | null>(db, athleteId, META_KEY, null);
  if (!meta || meta.version !== ACHIEVEMENTS_VERSION || meta.weekStart !== weekStartOfAthlete(db, athleteId))
    recomputeAchievements(db, athleteId, nowSec(), { initial: true });
}

/** "Delete all data" empties consistency_achievements (Feature.onReset): the state of the cache goes with it. */
export function resetAchievements(db: Db, athleteId: number): void {
  run(db, 'DELETE FROM settings WHERE athlete_id = ? AND key = ?', [athleteId, META_KEY]);
}

interface AchievementRow {
  key: string;
  grp: string;
  kind: string;
  tier: string;
  sport: string | null;
  threshold: number;
  name: string | null;
  progress: number;
  earned_day: string | null;
  workout_id: number | null;
  first_seen_at: number | null;
  w_name: string | null;
  w_sport: string | null;
  w_start: number | null;
  w_tz: number | null;
}

/** Stored achievements (catalog order), optionally only those earned in [fromDay, toDay]. */
export function readAchievements(db: Db, athleteId: number, fromDay?: string, toDay?: string): Achievement[] {
  const now = nowSec();
  const range = fromDay && toDay ? 'AND a.earned_day >= ? AND a.earned_day <= ?' : '';
  return all<AchievementRow>(
    db,
    `SELECT a.key, a.grp, a.kind, a.tier, a.sport, a.threshold, a.name, a.progress, a.earned_day, a.workout_id,
            a.first_seen_at, w.name AS w_name, w.sport AS w_sport, w.start_ts AS w_start, w.tz_min AS w_tz
     FROM consistency_achievements a
     LEFT JOIN workouts w ON w.id = a.workout_id AND w.athlete_id = a.athlete_id
     WHERE a.athlete_id = ? ${range} ORDER BY a.ord`,
    fromDay && toDay ? [athleteId, fromDay, toDay] : [athleteId],
  ).map((r) => ({
    key: r.key,
    group: r.grp as AchievementGroup,
    kind: r.kind as AchievementKind,
    tier: r.tier as AchievementTier,
    sport: r.sport,
    threshold: r.threshold,
    name: r.name,
    progress: r.progress,
    earned: r.earned_day !== null,
    earnedDay: r.earned_day,
    workout:
      r.workout_id !== null && r.w_start !== null
        ? { id: r.workout_id, name: r.w_name ?? '', sport: r.w_sport ?? 'other', startTs: r.w_start, tzMin: r.w_tz ?? 0 }
        : null,
    isNew: r.earned_day !== null && r.first_seen_at !== null && now - r.first_seen_at < NEW_WINDOW_S,
  }));
}

export function trophiesResponse(db: Db, athleteId: number, today?: string): TrophiesResponse {
  ensureAchievements(db, athleteId);
  const days = resolveDays(db, athleteId, today);
  const achievements = readAchievements(db, athleteId);
  const tiers = Object.fromEntries(
    ACHIEVEMENT_TIERS.map((t) => {
      const of = achievements.filter((a) => a.tier === t);
      return [t, { earned: of.filter((a) => a.earned).length, total: of.length }];
    }),
  ) as TrophiesResponse['summary']['tiers'];
  const months = challengeMonths(loadChallengeWorkouts(db, athleteId), days.asOf);
  const current = months[months.length - 1]!;
  return {
    today: days.today,
    asOf: days.asOf,
    achievements,
    summary: { earned: achievements.filter((a) => a.earned).length, total: achievements.length, tiers },
    challenges: {
      defs: CHALLENGES,
      current: {
        ...current,
        daysLeft: daysBetween(days.asOf, monthEndOf(days.asOf)) + 1,
        totalDays: daysInMonth(current.month),
      },
      history: months.slice(0, -1).reverse(),
      completedTotal: months.reduce((s, m) => s + m.completed, 0),
    },
  };
}

/**
 * True when this run's workouts are all the athlete has (the first import, also after a data reset): the same rule as
 * the import summary's `initial`. A trophies page opened while that import ran may have cached a partial history.
 */
function firstImport(ctx: DeriveContext): boolean {
  if (ctx.workoutIds === 'all' || !ctx.workoutIds.length) return false;
  const total = get<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM workouts WHERE athlete_id = ?', [ctx.athleteId])!.n;
  return ctx.workoutIds.length >= total;
}

export const achievementsStep: DeriveStep = {
  id: 'consistency.achievements',
  label: 'Trophies & challenges',
  weight: 0.3,
  run(ctx) {
    ctx.checkCancelled();
    const r = recomputeAchievements(ctx.db, ctx.athleteId, nowSec(), { initial: firstImport(ctx) });
    ctx.report(1, `${r.earned}/${r.total} trophies${r.newlyEarned ? `, ${r.newlyEarned} new` : ''}`);
  },
};
