import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ActivitiesSummary,
  ActivityAnalysis,
  ActivityListPage,
  ActivityListQuery,
  ActivityNav,
  ActivitySimilar,
  MapsRouteDetail,
  MapsWorkoutLinks,
  SportCount,
  WorkoutDetail,
  WorkoutPatch,
  WorkoutStreams,
} from '@cadence/shared';
import { api, useApi, type QueryParams } from '@/lib/api';
import { useSettings } from '@/lib/settings';
import { todayKey } from '@/lib/time';

/** Data hooks of the activities feature. Query keys start with 'activities'. */

export function useActivitiesSummary() {
  const { settings } = useSettings();
  return useApi<ActivitiesSummary>(['activities', 'summary'], '/activities/summary', {
    today: todayKey(),
    weekStart: settings.weekStart,
  });
}

export function useSportCounts() {
  return useApi<SportCount[]>(['activities', 'sports'], '/meta/sports');
}

export function useActivityList(query: ActivityListQuery) {
  return useApi<ActivityListPage>(['activities', 'list'], '/activities/list', query as QueryParams);
}

export const FEED_PAGE = 10;

/** Dashboard feed: newest first, pages of FEED_PAGE. */
export function useFeed() {
  return useInfiniteQuery({
    queryKey: ['activities', 'feed'],
    queryFn: ({ pageParam }) => api.get<ActivityListPage>('/activities/list', { limit: FEED_PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last) => {
      const next = last.offset + last.items.length;
      return next < last.total ? next : undefined;
    },
  });
}

/** Per-activity queries never show the previous activity's data while the next one loads. */
const fresh = { placeholderData: undefined } as const;

export function useWorkout(id: number) {
  return useApi<WorkoutDetail>(['activities', 'detail', id], `/workouts/${id}`, undefined, fresh);
}

export function useStreams(id: number) {
  return useApi<WorkoutStreams>(['activities', 'streams', id], `/workouts/${id}/streams`, undefined, {
    ...fresh,
    staleTime: Infinity,
  });
}

export function useAnalysis(id: number) {
  return useApi<ActivityAnalysis>(['activities', 'analysis', id], `/activities/${id}/analysis`, undefined, fresh);
}

export function useSimilar(id: number) {
  return useApi<ActivitySimilar>(['activities', 'similar', id], `/activities/${id}/similar`, undefined, fresh);
}

export function useNav(id: number) {
  return useApi<ActivityNav>(['activities', 'nav', id], `/activities/${id}/nav`, undefined, fresh);
}

/**
 * The recurring route of a workout and the efforts on it, read from the maps feature's API (same query keys as the
 * maps pages and the route card on the activity page, so the data is shared).
 */
export function useRouteLinks(id: number, enabled = true) {
  return useApi<MapsWorkoutLinks>(['maps', 'workout', id], enabled ? `/maps/workouts/${id}` : null);
}

export function useRouteDetail(routeId: number | null) {
  return useApi<MapsRouteDetail>(['maps', 'route', routeId], routeId ? `/maps/routes/${routeId}` : null);
}

/** Activities of one sport for the compare picker: newest first, or matching a search term. */
export function useSportActivities(sport: string, q: string, enabled = true) {
  return useApi<ActivityListPage>(['activities', 'compare-search'], enabled ? '/activities/list' : null, {
    sport,
    q: q.trim() || undefined,
    limit: 20,
  });
}

/**
 * PATCH /api/workouts/:id. Updates the cached detail, refreshes every non-core query (other features show titles,
 * sports and totals too) and the import job list — sport and hidden changes start a background re-derivation.
 */
export function usePatchWorkout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: WorkoutPatch }) => api.patch<WorkoutDetail>(`/workouts/${id}`, patch),
    onSuccess: async (detail, { patch }) => {
      qc.setQueryData(['activities', 'detail', detail.id, null], detail);
      await qc.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] !== 'core' &&
          !(q.queryKey[0] === 'activities' && (q.queryKey[1] === 'streams' || (q.queryKey[1] === 'detail' && q.queryKey[2] === detail.id))),
      });
      if (patch.sport !== undefined || patch.hidden !== undefined) await qc.invalidateQueries({ queryKey: ['core', 'import-jobs'] });
    },
  });
}
