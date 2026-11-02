import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type {
  PaceAtHrResponse,
  ProgressBucket,
  ProgressCompareResponse,
  ProgressEffortHistory,
  ProgressFitnessResponse,
  ProgressHrBand,
  ProgressIntensityResponse,
  ProgressOverview,
  ProgressPhysiology,
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

/** Remember the heart-rate band of a sport (server-side preference, shared by all devices). */
export function useSaveHrBand() {
  const qc = useQueryClient();
  return useCallback(
    async (sport: string, band: ProgressHrBand) => {
      await api.patch<ProgressPreferences>('/progress/preferences', { hrBands: { [sport]: band } });
      await qc.invalidateQueries({ queryKey: key('pace-at-hr') });
    },
    [qc],
  );
}
