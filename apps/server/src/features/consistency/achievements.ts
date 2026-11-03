/**
 * Trophy catalog and rules (pure, unit-tested). The catalog depends on the athlete's sports (distance
 * ladders only for sports they do) and on whether activity ring data exists. Evaluation replays the
 * whole history in order, so earned dates and activities are deterministic.
 */
import {
  TRIATHLON_DISTANCES,
  sportInfo,
  type AchievementGroup,
  type AchievementKind,
  type AchievementTier,
} from '@cadence/shared';
import { DISTANCE_TOLERANCE } from './challenges';
import { epoch, fromEpoch, plusDays, weekStartEpoch } from './days';
import { dayRuns, firstDayReaching, weekRuns } from './streaks';

export interface AchievementDef {
  key: string;
  group: AchievementGroup;
  kind: AchievementKind;
  tier: AchievementTier;
  sport: string | null;
  threshold: number;
  name: string | null;
}

/** Bump when rules or the catalog change: stored results are then recomputed on the next read. */
export const ACHIEVEMENTS_VERSION = 2;

type Step = [threshold: number, tier: AchievementTier, name?: string];

const b = 'bronze';
const s = 'silver';
const g = 'gold';

const ACTIVITY_COUNTS: Step[] = [
  [1, b, 'firstActivity'],
  [10, b],
  [25, b],
  [50, s],
  [100, s],
  [250, s],
  [500, g],
  [1000, g],
  [2000, g],
  [5000, g],
];
const KM = 1000;
const SPORT_DISTANCE: Record<string, Step[]> = {
  default: [[100 * KM, b], [500 * KM, b], [1000 * KM, s], [5000 * KM, g], [10000 * KM, g], [25000 * KM, g], [50000 * KM, g]],
  swim: [[10 * KM, b], [50 * KM, b], [100 * KM, s], [250 * KM, g], [500 * KM, g], [1000 * KM, g]],
};
const LONGEST: Record<string, Step[]> = {
  run: [
    [5000, b, 'first5k'],
    [10000, b, 'first10k'],
    [21097.5, s, 'half'],
    [30000, s],
    [42195, g, 'marathon'],
    [50000, g, 'ultra'],
    [100000, g, 'ultra100'],
  ],
  ride: [
    [25000, b],
    [40000, b, 'olympicBike'],
    [50000, b],
    [90000, s, 'halfIronmanBike'],
    [100000, s, 'century'],
    [160934.4, g, 'imperialCentury'],
    [180246, g, 'ironmanBike'],
    [200000, g],
    [300000, g],
  ],
  swim: [
    [1000, b],
    [1500, b, 'olympicSwim'],
    [1900, s, 'halfIronmanSwim'],
    [2000, s],
    [3800, g, 'ironmanSwim'],
    [5000, g],
    [10000, g],
  ],
};
const ELEVATION: Step[] = [
  [1000, b],
  [3798, b, 'grossglockner'],
  [4806, s, 'montBlanc'],
  [8848, s, 'everest'],
  [25000, g],
  [50000, g],
  [100000, g, 'karman'],
  [250000, g],
  [500000, g],
];
/** Swim + bike + run of a triathlon distance on one day; threshold = the total distance. */
const TRIATHLON: Step[] = TRIATHLON_DISTANCES.map((d, i): Step => [d.swim + d.ride + d.run, i === 0 ? b : i === 1 ? s : g, d.key]);
const DAY_STREAKS: Step[] = [[7, b], [30, s], [100, g], [365, g], [500, g], [1000, g]];
const WEEK_STREAKS: Step[] = [[4, b], [12, s], [26, g], [52, g], [104, g], [260, g]];
const HABIT_COUNTS: Step[] = [[1, b], [10, s], [50, g]];
const WEEKENDS: Step[] = [[4, b], [12, s], [26, g]];
const VARIETY: Step[] = [[3, b], [5, s], [8, g]];
const RING_STREAKS: Step[] = [[7, b], [30, s], [100, g], [365, g], [500, g], [1000, g]];
const PERFECT_WEEKS: Step[] = [[1, b], [10, s], [52, g]];
const DOUBLE_MOVE: Step[] = [[1, b], [25, s], [100, g]];
const CHALLENGE_COUNTS: Step[] = [[1, b], [10, s], [25, g], [50, g]];

function ladder(group: AchievementGroup, kind: AchievementKind, steps: Step[], sport: string | null = null): AchievementDef[] {
  return steps.map(([threshold, tier, name]) => ({
    key: `${kind}${sport ? `.${sport}` : ''}.${threshold}`,
    group,
    kind,
    tier,
    sport,
    threshold,
    name: name ?? null,
  }));
}

/** The athlete's catalog: distance ladders for every distance sport they did, rings only with ring data. */
export function buildCatalog(o: { sports: string[]; hasRings: boolean }): AchievementDef[] {
  const sports = [...new Set(o.sports)].sort();
  const distanceSports = sports.filter((sp) => sportInfo(sp).distance && sp !== 'multisport');
  return [
    ...ladder('milestones', 'activities', ACTIVITY_COUNTS),
    ...ladder('habits', 'variety', VARIETY),
    ...distanceSports.flatMap((sp) => ladder('distance', 'sport_distance', SPORT_DISTANCE[sp] ?? SPORT_DISTANCE.default!, sp)),
    ...Object.keys(LONGEST)
      .filter((sp) => sports.includes(sp) || sports.includes('multisport'))
      .flatMap((sp) => ladder('longest', 'longest', LONGEST[sp]!, sp)),
    // triathlons only for athletes who swim, ride and run (or record multisport)
    ...(['swim', 'ride', 'run'].every((sp) => sports.includes(sp)) || sports.includes('multisport')
      ? ladder('longest', 'triathlon', TRIATHLON)
      : []),
    ...ladder('climbing', 'elevation', ELEVATION),
    ...ladder('streaks', 'daily_streak', DAY_STREAKS),
    ...ladder('streaks', 'weekly_streak', WEEK_STREAKS),
    ...ladder('habits', 'early_bird', HABIT_COUNTS),
    ...ladder('habits', 'night_owl', HABIT_COUNTS),
    ...ladder('habits', 'weekend_warrior', WEEKENDS),
    ...(o.hasRings
      ? [
          ...ladder('rings', 'move_streak', RING_STREAKS),
          ...ladder('rings', 'exercise_streak', RING_STREAKS),
          ...ladder('rings', 'stand_streak', RING_STREAKS),
          ...ladder('rings', 'perfect_week', PERFECT_WEEKS),
          ...ladder('rings', 'double_move', DOUBLE_MOVE),
        ]
      : []),
    ...ladder('challenges', 'challenges', CHALLENGE_COUNTS),
  ];
}

export interface EvalWorkout {
  id: number;
  sport: string;
  startTs: number;
  /** Local day / weekday (0 = Sunday) / hour at the start. */
  day: string;
  weekday: number;
  hour: number;
  distanceM: number;
  elevationM: number;
}

export interface EvalRingDay {
  day: string;
  /** value / goal fractions */
  move: number | null;
  exercise: number | null;
  stand: number | null;
}

export interface EvalInput {
  /** Visible workouts sorted by start. */
  workouts: EvalWorkout[];
  /**
   * Legs of multisport workouts (swim / bike / run of a triathlon) with the id of their workout: they count for the
   * single-activity distances and triathlons, never as activities of their own.
   */
  legs?: EvalWorkout[];
  rings: EvalRingDay[];
  weekStart: 0 | 1;
  /** Days on which monthly challenges were completed (any order). */
  challengeDays: string[];
}

export interface EvalResult {
  key: string;
  progress: number;
  earnedDay: string | null;
  workoutId: number | null;
}

interface Point {
  value: number;
  day: string;
  workoutId: number | null;
}

/** First point at which the running value reached the threshold. */
function crossing(points: Point[], threshold: number): Point | null {
  for (const p of points) if (p.value >= threshold - 1e-6) return p;
  return null;
}

const EPS = 1e-6;
export const closed = (f: number | null | undefined): boolean => f !== null && f !== undefined && f >= 1 - EPS;
export const isEarlyBird = (hour: number): boolean => hour >= 4 && hour < 7;
export const isNightOwl = (hour: number): boolean => hour >= 21 || hour < 4;

/** Evaluate every achievement of the catalog against the athlete's history. */
export function evaluateAchievements(defs: AchievementDef[], input: EvalInput): EvalResult[] {
  const ws = input.workouts;
  const firstWorkoutOn = new Map<string, number>();
  for (const w of ws) if (!firstWorkoutOn.has(w.day)) firstWorkoutOn.set(w.day, w.id);
  const dayPoint = (day: string, value: number): Point => ({ value, day, workoutId: firstWorkoutOn.get(day) ?? null });

  // running counts / sums over workouts
  const counting = (pred: (w: EvalWorkout) => boolean, amount: (w: EvalWorkout) => number = () => 1): Point[] => {
    const out: Point[] = [];
    let v = 0;
    for (const w of ws) {
      if (!pred(w)) continue;
      v += amount(w);
      out.push({ value: v, day: w.day, workoutId: w.id });
    }
    return out;
  };
  const maxOf = (points: Point[]) => (points.length ? points[points.length - 1]!.value : 0);

  const activities = counting(() => true);
  const elevation = counting(
    (w) => w.elevationM > 0,
    (w) => w.elevationM,
  );
  const early = counting((w) => isEarlyBird(w.hour));
  const night = counting((w) => isNightOwl(w.hour));
  const seenSports = new Set<string>();
  const variety = counting((w) => {
    if (w.sport === 'transition' || seenSports.has(w.sport)) return false;
    seenSports.add(w.sport);
    return true;
  });

  const activeDays = [...firstWorkoutOn.keys()];
  const activeSet = new Set(activeDays);
  const dRuns = dayRuns(activeDays);
  const longestDayRun = dRuns.reduce((m, r) => Math.max(m, r.length), 0);
  const wRuns = weekRuns(activeDays, input.weekStart, 1);
  const longestWeekRun = wRuns.reduce((m, r) => Math.max(m, r.length), 0);

  // weekends with activity on Saturday and Sunday (independent of the week start setting)
  const weekends: Point[] = [];
  for (const d of [...activeSet].sort()) {
    const e = epoch(d);
    if ((((e + 4) % 7) + 7) % 7 !== 0) continue; // Sunday
    if (activeSet.has(fromEpoch(e - 1))) weekends.push(dayPoint(d, weekends.length + 1));
  }

  // rings
  const rings = [...input.rings].sort((a, b) => (a.day < b.day ? -1 : 1));
  const ringDays = (pick: (r: EvalRingDay) => number | null) => rings.filter((r) => closed(pick(r))).map((r) => r.day);
  const moveDays = ringDays((r) => r.move);
  const exerciseDays = ringDays((r) => r.exercise);
  const standDays = ringDays((r) => r.stand);
  const ringRuns = { move: dayRuns(moveDays), exercise: dayRuns(exerciseDays), stand: dayRuns(standDays) };
  const perfectDays = new Set(rings.filter((r) => closed(r.move) && closed(r.exercise) && closed(r.stand)).map((r) => r.day));
  const perfectWeeks: Point[] = [];
  {
    const weeks = new Map<number, number>();
    for (const d of perfectDays) {
      const w = weekStartEpoch(epoch(d), input.weekStart);
      weeks.set(w, (weeks.get(w) ?? 0) + 1);
    }
    for (const w of [...weeks.keys()].sort((a, b) => a - b))
      if (weeks.get(w) === 7) perfectWeeks.push({ value: perfectWeeks.length + 1, day: fromEpoch(w + 6), workoutId: null });
  }
  const doubleMove: Point[] = [];
  for (const r of rings) if (r.move !== null && r.move >= 2 - EPS) doubleMove.push({ value: doubleMove.length + 1, day: r.day, workoutId: null });

  const challenges: Point[] = [...input.challengeDays]
    .sort()
    .map((day, i) => ({ value: i + 1, day, workoutId: null }));

  // per-sport sequences (cumulative distance, best single distance); multisport legs count as single efforts
  const sportCum = new Map<string, Point[]>();
  const sportBest = new Map<string, Point[]>();
  for (const w of ws) {
    if (!(w.distanceM > 0)) continue;
    const cum = sportCum.get(w.sport) ?? [];
    cum.push({ value: (cum[cum.length - 1]?.value ?? 0) + w.distanceM, day: w.day, workoutId: w.id });
    sportCum.set(w.sport, cum);
  }
  const singles = [...ws, ...(input.legs ?? [])].sort((a, b) => a.startTs - b.startTs || a.id - b.id);
  for (const w of singles) {
    if (!(w.distanceM > 0)) continue;
    const best = sportBest.get(w.sport) ?? [];
    if (w.distanceM > (best[best.length - 1]?.value ?? 0)) best.push({ value: w.distanceM, day: w.day, workoutId: w.id });
    sportBest.set(w.sport, best);
  }
  // triathlon days: the longest swim, ride and run of every local day
  const triDays = new Map<string, { swim: number; ride: number; run: number; workoutId: number }>();
  for (const w of singles) {
    if (w.sport !== 'swim' && w.sport !== 'ride' && w.sport !== 'run') continue;
    const d = triDays.get(w.day) ?? { swim: 0, ride: 0, run: 0, workoutId: w.id };
    d[w.sport] = Math.max(d[w.sport], w.distanceM);
    triDays.set(w.day, d);
  }
  /** Distance of a triathlon covered on the best day: every leg counts up to its full distance. */
  const triathlonPoints = (key: string): { best: number; earned: Point | null } => {
    const t = TRIATHLON_DISTANCES.find((x) => x.key === key)!;
    let best = 0;
    let earned: Point | null = null;
    for (const [day, d] of [...triDays].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const tol = DISTANCE_TOLERANCE;
      const v = Math.min(d.swim, t.swim) + Math.min(d.ride, t.ride) + Math.min(d.run, t.run);
      best = Math.max(best, v);
      if (!earned && d.swim >= t.swim * tol && d.ride >= t.ride * tol && d.run >= t.run * tol)
        earned = { value: t.swim + t.ride + t.run, day, workoutId: d.workoutId };
    }
    return { best: earned ? t.swim + t.ride + t.run : best, earned };
  };

  const result = (d: AchievementDef, progress: number, p: Point | null): EvalResult => ({
    key: d.key,
    progress,
    earnedDay: p?.day ?? null,
    workoutId: p?.workoutId ?? null,
  });

  const fromRuns = (d: AchievementDef, runs: ReturnType<typeof dayRuns>, withWorkout: boolean): EvalResult => {
    const day = firstDayReaching(runs, d.threshold);
    const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
    return {
      key: d.key,
      progress: longest,
      earnedDay: day,
      workoutId: day && withWorkout ? (firstWorkoutOn.get(day) ?? null) : null,
    };
  };

  return defs.map((d): EvalResult => {
    switch (d.kind) {
      case 'activities':
        return result(d, maxOf(activities), crossing(activities, d.threshold));
      case 'variety':
        return result(d, maxOf(variety), crossing(variety, d.threshold));
      case 'sport_distance': {
        const pts = sportCum.get(d.sport!) ?? [];
        return result(d, maxOf(pts), crossing(pts, d.threshold));
      }
      case 'longest': {
        const pts = sportBest.get(d.sport!) ?? [];
        return result(d, maxOf(pts), crossing(pts, d.threshold * DISTANCE_TOLERANCE));
      }
      case 'elevation':
        return result(d, maxOf(elevation), crossing(elevation, d.threshold));
      case 'daily_streak':
        return { ...fromRuns(d, dRuns, true), progress: longestDayRun };
      case 'weekly_streak': {
        const run = wRuns.find((r) => r.length >= d.threshold);
        let day: string | null = null;
        if (run) {
          // the week that completed the streak: its first active day
          const weekStartDay = plusDays(run.start, (d.threshold - 1) * 7);
          for (let i = 0; i < 7 && !day; i++) {
            const x = plusDays(weekStartDay, i);
            if (activeSet.has(x)) day = x;
          }
        }
        return {
          key: d.key,
          progress: longestWeekRun,
          earnedDay: day,
          workoutId: day ? (firstWorkoutOn.get(day) ?? null) : null,
        };
      }
      case 'early_bird':
        return result(d, maxOf(early), crossing(early, d.threshold));
      case 'night_owl':
        return result(d, maxOf(night), crossing(night, d.threshold));
      case 'weekend_warrior':
        return result(d, maxOf(weekends), crossing(weekends, d.threshold));
      case 'move_streak':
        return fromRuns(d, ringRuns.move, false);
      case 'exercise_streak':
        return fromRuns(d, ringRuns.exercise, false);
      case 'stand_streak':
        return fromRuns(d, ringRuns.stand, false);
      case 'perfect_week':
        return result(d, maxOf(perfectWeeks), crossing(perfectWeeks, d.threshold));
      case 'double_move':
        return result(d, maxOf(doubleMove), crossing(doubleMove, d.threshold));
      case 'challenges':
        return result(d, maxOf(challenges), crossing(challenges, d.threshold));
      case 'triathlon': {
        const p = triathlonPoints(d.name!);
        return result(d, p.best, p.earned);
      }
    }
  });
}
