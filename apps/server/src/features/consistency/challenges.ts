/**
 * Monthly challenges (pure, unit-tested): fixed targets that reset every calendar month.
 * Completion day = the local day on which the month's running total reached the target.
 */
import type { ChallengeDef, ChallengeMonth, ChallengeProgress } from '@cadence/shared';

export const CHALLENGES: ChallengeDef[] = [
  { key: 'run50', metric: 'distance', sport: 'run', target: 50_000 },
  { key: 'run100', metric: 'distance', sport: 'run', target: 100_000 },
  { key: 'ride200', metric: 'distance', sport: 'ride', target: 200_000 },
  { key: 'climb1000', metric: 'elevation', sport: null, target: 1000 },
  { key: 'activities10', metric: 'activities', sport: null, target: 10 },
  { key: 'runs5k', metric: 'runs5k', sport: 'run', target: 5 },
  { key: 'active20', metric: 'active_days', sport: null, target: 20 },
];

/** GPS/rounding tolerance for distance thresholds of single activities ("a 5K" = ≥ 4,975 m). */
export const DISTANCE_TOLERANCE = 0.995;

export interface ChallengeWorkout {
  id: number;
  sport: string;
  /** Local day 'YYYY-MM-DD'. */
  day: string;
  distanceM: number;
  elevationM: number;
}

/** 'YYYY-MM' of the month after `month`. */
export function nextMonth(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** Inclusive list of months 'YYYY-MM'. */
export function monthsBetween(first: string, last: string): string[] {
  const out: string[] = [];
  for (let m = first; m <= last && out.length < 2400; m = nextMonth(m)) out.push(m);
  return out;
}

function contribution(def: ChallengeDef, w: ChallengeWorkout): number {
  if (def.sport !== null && w.sport !== def.sport) return 0;
  switch (def.metric) {
    case 'distance':
      return w.distanceM;
    case 'elevation':
      return w.elevationM;
    case 'activities':
      return 1;
    case 'runs5k':
      return w.distanceM >= 5000 * DISTANCE_TOLERANCE ? 1 : 0;
    case 'active_days':
      return 0; // counted per distinct day below
  }
}

/** Progress of every challenge in each month from `firstMonth` to `lastMonth` (oldest first). */
export function computeChallenges(
  workouts: ChallengeWorkout[],
  firstMonth: string,
  lastMonth: string,
  defs: ChallengeDef[] = CHALLENGES,
): ChallengeMonth[] {
  const byMonth = new Map<string, ChallengeWorkout[]>();
  for (const w of workouts) {
    const m = w.day.slice(0, 7);
    let list = byMonth.get(m);
    if (!list) byMonth.set(m, (list = []));
    list.push(w);
  }
  return monthsBetween(firstMonth, lastMonth).map((month) => {
    const list = [...(byMonth.get(month) ?? [])].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const items: ChallengeProgress[] = defs.map((def) => {
      let value = 0;
      let completedDay: string | null = null;
      const days = new Set<string>();
      for (const w of list) {
        if (def.metric === 'active_days') {
          if (def.sport !== null && w.sport !== def.sport) continue;
          days.add(w.day);
          value = days.size;
        } else value += contribution(def, w);
        if (completedDay === null && value >= def.target) completedDay = w.day;
      }
      return { key: def.key, value, target: def.target, completedDay };
    });
    return { month, items, completed: items.filter((i) => i.completedDay !== null).length };
  });
}
