import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { PROGRESS_VOLUME_METRICS, sportInfo, type ProgressOverview, type ProgressVolumeMetric } from '@cadence/shared';
import { todayKey } from '@/lib/time';
import { isPeriodPreset, presetRange, type PeriodPreset } from './periods';

/**
 * Filters of a progress page (sport · period · metric), kept in the URL so views can be linked and the back
 * button works. Defaults: the most frequent sport, 12 months, distance (time for sports without distance).
 */
export function useProgressFilters(overview: ProgressOverview | undefined, defaults: { period?: PeriodPreset; sport?: string } = {}) {
  const [params, setParams] = useSearchParams();
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

  const set = useCallback(
    (key: string, value: string) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(key, value);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
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
    setSport: (v: string) => set('sport', v),
    setPeriod: (v: PeriodPreset) => set('period', v),
    setMetric: (v: ProgressVolumeMetric) => set('metric', v),
  };
}
