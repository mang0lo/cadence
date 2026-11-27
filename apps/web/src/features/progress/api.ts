import { useQueryClient, type Query, type QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type {
  PaceAtHrResponse,
  ProgressBucket,
  ProgressCompareResponse,
  ProgressEffortHistory,
  ProgressFitnessResponse,
  ProgressFtpResponse,
  ProgressHrBand,
  ProgressIntensityResponse,
  ProgressOverview,
  ProgressPhysiology,
  ProgressPowerCompare,
  ProgressPowerCurveResponse,
  ProgressPowerPeriod,
  ProgressPredictions,
  ProgressPreferences,
  ProgressRecordsResponse,
  ProgressTrendsResponse,
  ProgressVolumeMetric,
  ProgressVolumeResponse,
  ProgressWeeklySnapshot,
  ProgressYoyResponse,
} from '@cadence/shared';
import { api, useApi } from '@/lib/api';
import { todayKey } from '@/lib/time';

/** Query keys start with 'progress' so a finished import invalidates everything. */
const key = (name: string) => ['progress', name] as const;

/** 'all' (or null) → every sport. */
const sportParam = (sport: string | null) => (sport && sport !== 'all' ? sport : undefined);

export interface RangeParams {
  fromDay: string;
  toDay: string;
}

export const useOverview = () => useApi<ProgressOverview>(key('overview'), '/progress/overview');

export const useVolume = (sport: string | null, bucket: ProgressBucket, range: RangeParams | null) =>
  useApi<ProgressVolumeResponse>(key('volume'), range ? '/progress/volume' : null, {
    sport: sportParam(sport),
    bucket,
    ...range,
  });

export const useYoy = (sport: string | null, metric: ProgressVolumeMetric) =>
  useApi<ProgressYoyResponse>(key('yoy'), '/progress/yoy', { sport: sportParam(sport), metric, today: todayKey() });

export const useCompare = (
  sport: string | null,
  period: 'week' | 'month' | 'year' | 'custom',
  offset: number,
  custom: RangeParams | null,
) =>
  useApi<ProgressCompareResponse>(key('compare'), period === 'custom' && !custom ? null : '/progress/compare', {
    sport: sportParam(sport),
    period,
    offset: period === 'custom' ? undefined : offset,
    ...(period === 'custom' ? custom : {}),
    today: todayKey(),
  });

export const useTrends = (sport: string | null, range: RangeParams | null) =>
  useApi<ProgressTrendsResponse>(key('trends'), range && sportParam(sport) ? '/progress/trends' : null, {
    sport: sportParam(sport),
    ...range,
  });

export const usePaceAtHr = (sport: string | null, range: RangeParams | null, band: ProgressHrBand | null) =>
  useApi<PaceAtHrResponse>(key('pace-at-hr'), range && sportParam(sport) ? '/progress/pace-at-hr' : null, {
    sport: sportParam(sport),
    ...range,
    lo: band?.lo,
    hi: band?.hi,
  });

export const useIntensity = (sport: string | null, bucket: 'week' | 'month', range: RangeParams | null) =>
  useApi<ProgressIntensityResponse>(key('intensity'), range ? '/progress/intensity' : null, {
    sport: sportParam(sport),
    bucket,
    ...range,
  });

export const useRecords = (sport: string | null) =>
  useApi<ProgressRecordsResponse>(key('records'), '/progress/records', { sport: sportParam(sport), today: todayKey() });

export const useEffortHistory = (sport: string | null, effort: string | null) =>
  useApi<ProgressEffortHistory>(key('effort-history'), sportParam(sport) && effort ? '/progress/records/history' : null, {
    sport: sportParam(sport),
    effort: effort ?? undefined,
  });

export const usePredictions = (enabled: boolean) =>
  useApi<ProgressPredictions>(key('predictions'), enabled ? '/progress/predictions' : null, { today: todayKey() });

export const useFitness = (sport: string | null, range: RangeParams | null) =>
  useApi<ProgressFitnessResponse>(key('fitness'), range ? '/progress/fitness' : null, {
    sport: sportParam(sport),
    ...range,
    today: todayKey(),
  });

export const usePhysiology = (range: RangeParams | null) =>
  useApi<ProgressPhysiology>(key('physiology'), range ? '/progress/physiology' : null, { ...range });

export const useSnapshot = () =>
  useApi<ProgressWeeklySnapshot>(key('snapshot'), '/progress/snapshot', { today: todayKey() });

export interface PowerCurveParams {
  /** null = the server's default (ride when it has power data). */
  sport: string | null;
  period: ProgressPowerPeriod;
  year?: number;
  fromDay?: string;
  toDay?: string;
  compare: ProgressPowerCompare;
}

/** Power curve of a period + comparison (null = do not fetch, e.g. while a custom range is incomplete). */
export const usePowerCurve = (p: PowerCurveParams | null) =>
  useApi<ProgressPowerCurveResponse>(
    key('power-curve'),
    p ? '/progress/power/curve' : null,
    p
      ? {
          sport: sportParam(p.sport),
          period: p.period,
          year: p.period === 'year' ? p.year : undefined,
          fromDay: p.period === 'custom' ? p.fromDay : undefined,
          toDay: p.period === 'custom' ? p.toDay : undefined,
          compare: p.compare,
          today: todayKey(),
        }
      : undefined,
  );

/** FTP estimate, critical power and the estimate per month for a sport (null = the server's default). */
export const useFtpEstimate = (sport: string | null) =>
  useApi<ProgressFtpResponse>(key('power-ftp'), '/progress/power/ftp', { sport: sportParam(sport), today: todayKey() });

/**
 * The cache after `band` was saved for `sport`. The card already shows that band (it asks for it explicitly), so
 * nothing is fetched again: the cached responses of the sport list it as their 'saved' suggestion (first, like the
 * server does), and only the responses without an explicit band, whose default was the old saved band, are
 * invalidated (refetched if shown, otherwise when next used). Other sports keep their own saved band.
 */
export function applySavedHrBand(qc: QueryClient, sport: string, band: ProgressHrBand): Promise<void> {
  const params = (q: Query) => q.queryKey[2] as { sport?: string; lo?: number } | null | undefined;
  qc.setQueriesData<PaceAtHrResponse>({ queryKey: key('pace-at-hr'), predicate: (q) => params(q)?.sport === sport }, (old) =>
    old
      ? { ...old, suggestions: [{ key: 'saved', lo: band.lo, hi: band.hi }, ...old.suggestions.filter((s) => s.key !== 'saved')] }
      : old,
  );
  return qc.invalidateQueries({ queryKey: key('pace-at-hr'), predicate: (q) => params(q)?.sport === sport && params(q)?.lo === undefined });
}

/** Remember the heart-rate band of a sport (server-side preference, shared by all devices). */
export function useSaveHrBand() {
  const qc = useQueryClient();
  return useCallback(
    async (sport: string, band: ProgressHrBand) => {
      await api.patch<ProgressPreferences>('/progress/preferences', { hrBands: { [sport]: band } });
      await applySavedHrBand(qc, sport, band);
    },
    [qc],
  );
}
