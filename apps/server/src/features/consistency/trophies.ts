/**
 * Trophies: the derive step evaluates the catalog against the full history and caches the results in
 * consistency_achievements (with the day + activity that earned each one). Reads recompute lazily when the
 * cache is missing or was written by an older rule version. Monthly challenges are computed on the fly.
 */
import {
  ACHIEVEMENT_TIERS,
  type Achievement,
  type AchievementGroup,
  type AchievementKind,
  type AchievementTier,
  type ChallengeMonth,
  type TrophiesResponse,
} from '@cadence/shared';
import { all, run, tx, type Db } from '../../db/db';
import { getSetting, setSetting } from '../../core/settings';
import type { DeriveStep } from '../types';
import { nowSec } from '../../lib/time';
import { ACHIEVEMENTS_VERSION, buildCatalog, evaluateAchievements, type EvalInput } from './achievements';
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
    input: { workouts, rings, weekStart: weekStartOfAthlete(db, athleteId), challengeDays: [] },
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
function challengeMonths(h: History, asOf: string): ChallengeMonth[] {
  const last = asOf.slice(0, 7);
  const first = h.challengeWorkouts.reduce((m, w) => (w.day.slice(0, 7) < m ? w.day.slice(0, 7) : m), last);
  return computeChallenges(h.challengeWorkouts, first, last);
}

export interface RecomputeResult {
  total: number;
  earned: number;
  newlyEarned: number;
}

/** Evaluate and store all achievements of an athlete. */
export function recomputeAchievements(db: Db, athleteId: number, now = nowSec()): RecomputeResult {
  const h = loadHistory(db, athleteId);
  const { asOf } = resolveDays(db, athleteId);
  h.input.challengeDays = challengeMonths(h, asOf).flatMap((m) =>
    m.items.flatMap((i) => (i.completedDay ? [i.completedDay] : [])),
  );
  const catalog = buildCatalog({ sports: h.sports, hasRings: h.hasRings });
  const results = evaluateAchievements(catalog, h.input);
  const initial = getSetting<unknown>(db, athleteId, META_KEY, null) === null;
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
    setSetting(db, athleteId, META_KEY, { version: ACHIEVEMENTS_VERSION, computedAt: now });
  });
  return { total: catalog.length, earned, newlyEarned };
}

/** Recompute when the cache is missing or stale (older rules, never derived). */
export function ensureAchievements(db: Db, athleteId: number): void {
  const meta = getSetting<{ version?: number } | null>(db, athleteId, META_KEY, null);
  if (!meta || meta.version !== ACHIEVEMENTS_VERSION) recomputeAchievements(db, athleteId);
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
  const months = challengeMonths(loadHistory(db, athleteId), days.asOf);
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

export const achievementsStep: DeriveStep = {
  id: 'consistency.achievements',
  label: 'Trophies & challenges',
  weight: 0.3,
  run(ctx) {
    ctx.checkCancelled();
    const r = recomputeAchievements(ctx.db, ctx.athleteId);
    ctx.report(1, `${r.earned}/${r.total} trophies${r.newlyEarned ? `, ${r.newlyEarned} new` : ''}`);
  },
};
