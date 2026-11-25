/** Data hooks of the consistency feature. Query keys start with 'consistency' (invalidated after imports). */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type {
  CalendarResponse,
  ConsistencyOverview,
  ConsistencyPrefs,
  DayDetail,
  Goal,
  GoalCheckResult,
  GoalInput,
  GoalsResponse,
  PunchcardResponse,
  SportCount,
  StreakSummary,
  TrophiesResponse,
  YearReview,
} from '@cadence/shared';
import { api, useApi } from '@/lib/api';
import { todayKey } from '@/lib/time';

export function useOverview() {
  return useApi<ConsistencyOverview>(['consistency', 'overview'], '/consistency/overview', { today: todayKey() });
}

export function useStreaks() {
  return useApi<StreakSummary>(['consistency', 'streaks'], '/consistency/streaks', { today: todayKey() });
}

export function useCalendar(range: { year: number } | { from: string; to: string } | { weeks: number } | null) {
  return useApi<CalendarResponse>(['consistency', 'calendar'], range ? '/consistency/calendar' : null, {
    ...(range ?? {}),
    today: todayKey(),
  });
}

export function useDayDetail(day: string | null) {
  return useApi<DayDetail>(['consistency', 'day', day], day ? `/consistency/day/${day}` : null);
}

export function usePunchcard(year: number | 'all') {
  return useApi<PunchcardResponse>(['consistency', 'punchcard'], '/consistency/punchcard', { year });
}

export function useGoals() {
  return useApi<GoalsResponse>(['consistency', 'goals'], '/consistency/goals', { today: todayKey() });
}

export function useTrophies() {
  return useApi<TrophiesResponse>(['consistency', 'trophies'], '/consistency/trophies', { today: todayKey() });
}

export function useYearReview(year: number | null) {
  return useApi<YearReview>(['consistency', 'year', year], year ? `/consistency/year/${year}` : '/consistency/year', {
    today: todayKey(),
  });
}

/** The athlete's sports (for goal forms). */
export function useSports() {
  return useApi<SportCount[]>(['consistency', 'sports'], '/meta/sports');
}

/**
 * Goal and preference mutations. Each refreshes only what depends on it: goals and check marks feed the goals and the
 * consistency score (overview, basis 'goals'), the preferences only the score. Streaks, calendars, punchcard, day
 * details, trophies and the year review do not depend on either, so they are neither refetched nor dimmed.
 */
export function useConsistencyMutations() {
  const qc = useQueryClient();
  const refreshGoals = useCallback(
    () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['consistency', 'goals'] }),
        qc.invalidateQueries({ queryKey: ['consistency', 'overview'] }),
      ]),
    [qc],
  );
  return {
    createGoal: useCallback(async (g: GoalInput) => {
      const out = await api.post<Goal>('/consistency/goals', g);
      await refreshGoals();
      return out;
    }, [refreshGoals]),
    updateGoal: useCallback(async (id: number, patch: Partial<GoalInput>) => {
      const out = await api.patch<Goal>(`/consistency/goals/${id}`, patch);
      await refreshGoals();
      return out;
    }, [refreshGoals]),
    deleteGoal: useCallback(async (id: number) => {
      await api.delete(`/consistency/goals/${id}`);
      await refreshGoals();
    }, [refreshGoals]),
    /** Check a goal off by hand (or take the check mark back) — `day`: a day of the period, default the current one. */
    checkGoal: useCallback(async (id: number, done: boolean, day?: string) => {
      const out = await api.put<GoalCheckResult>(`/consistency/goals/${id}/check`, { done, day, today: todayKey() });
      await refreshGoals();
      return out;
    }, [refreshGoals]),
    setPrefs: useCallback(async (patch: Partial<ConsistencyPrefs>) => {
      const out = await api.put<ConsistencyPrefs>('/consistency/prefs', patch);
      await qc.invalidateQueries({ queryKey: ['consistency', 'overview'] });
      return out;
    }, [qc]),
  };
}
