import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { PROGRESS_VOLUME_METRICS, SPORTS, sportInfo, type ProgressOverview, type ProgressVolumeMetric } from '@cadence/shared';
import { todayKey } from '@/lib/time';
import { isPeriodPreset, presetRange, type PeriodPreset } from './periods';

/** `prev` with `patch` applied: a string sets its key, null deletes it (a new object; `prev` stays as it is). */
export function patchParams(prev: URLSearchParams, patch: Record<string, string | null>): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) next.delete(k);
    else next.set(k, v);
  }
  return next;
}

/**
 * The search params of a progress page and a patcher for them (see patchParams). Changes replace the history entry,
 * so filter clicks do not pile up behind the back button.
 */
export function useUrlParams() {
  const [params, setParams] = useSearchParams();
  const patch = useCallback(
    (p: Record<string, string | null>) => setParams((prev) => patchParams(prev, p), { replace: true }),
    [setParams],
  );
  return [params, patch] as const;
}

/**
 * A sport key from the URL, or null for anything the app does not know (an old or hand-edited link such as
 * ?sport=running): null lets the server pick its default instead of failing the request. Inherited object keys
 * ('constructor', '__proto__') are no sports either.
 */
export function urlSport(raw: string | null): string | null {
  return raw && Object.hasOwn(SPORTS, raw) ? raw : null;
}

/**
 * Filters of a progress page (sport · period · metric), kept in the URL so views can be linked and the back
 * button works. Defaults: the most frequent sport, 12 months, distance (time for sports without distance).
 */
export function useProgressFilters(overview: ProgressOverview | undefined, defaults: { period?: PeriodPreset; sport?: string } = {}) {
  const [params, patch] = useUrlParams();
  const sports = overview?.sports ?? [];
  const rawSport = params.get('sport');
  const sport =
    rawSport === 'all' || (rawSport && sports.some((s) => s.sport === rawSport))
      ? rawSport
      : (defaults.sport ?? overview?.defaultSport ?? 'all');
  const rawPeriod = params.get('period');
  const period: PeriodPreset = isPeriodPreset(rawPeriod) ? rawPeriod : (defaults.period ?? '12m');
  const hasDistance = sport === 'all' || sportInfo(sport).distance;
  const rawMetric = params.get('metric') as ProgressVolumeMetric | null;
  let metric: ProgressVolumeMetric =
    rawMetric && PROGRESS_VOLUME_METRICS.includes(rawMetric) ? rawMetric : hasDistance ? 'distance' : 'time';
  if (!hasDistance && (metric === 'distance' || metric === 'elevation')) metric = 'time';

  const firstDay = overview?.firstDay ?? null;
  const range = useMemo(
    () => (overview ? presetRange(period, todayKey(), sport === 'all' ? firstDay : (sports.find((s) => s.sport === sport)?.firstDay ?? firstDay)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overview, period, sport, firstDay],
  );
  return {
    sport,
    period,
    metric,
    hasDistance,
    range,
    setSport: (v: string) => patch({ sport: v }),
    setPeriod: (v: PeriodPreset) => patch({ period: v }),
    setMetric: (v: ProgressVolumeMetric) => patch({ metric: v }),
  };
}
