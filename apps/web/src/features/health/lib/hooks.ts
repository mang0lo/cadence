import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import type { DailyMetric, HealthMeta, RecordTypeInfo } from '@cadence/shared';
import { useApi } from '@/lib/api';
import { useStoredState } from '@/lib/storage';
import { addDays, diffDays, todayKey } from '@/lib/time';
import { APPLE_METRICS } from './identifiers';

/** Latest data day, first data day, sleep goal … — anchors all "last N days" ranges to the data, not to today. */
export function useHealthMeta() {
  return useApi<HealthMeta>(['health', 'meta'], '/health/meta', undefined, { staleTime: 30_000 });
}

/**
 * daily_metrics keys of resting HR, HRV, VO₂max, steps and heart rate: Apple's or COROS' (Settings → My watch), as the
 * server reads them — use these instead of hard-coded HealthKit identifiers. `ready` is false while the meta loads
 * (the keys are Apple's until then).
 */
export function useHeartMetrics(): HealthMeta['metrics'] & { ready: boolean } {
  const meta = useHealthMeta();
  return { ...(meta.data?.metrics ?? APPLE_METRICS), ready: !meta.isLoading };
}

/** Record types of the athlete (core endpoint) – tells which metrics exist at all. */
export function useRecordTypes() {
  return useApi<RecordTypeInfo[]>(['health', 'types'], '/metrics/types', undefined, { staleTime: 60_000 });
}

/** Several daily_metrics series; keyed by metric. */
export function useDaily(metrics: string[], fromDay?: string, toDay?: string, enabled = true) {
  return useApi<Record<string, DailyMetric[]>>(
    ['health', 'daily', metrics.join(',')],
    enabled && metrics.length ? '/health/daily' : null,
    { metrics: metrics.join(','), fromDay, toDay },
  );
}

/** `?day=YYYY-MM-DD` when it is a real calendar day, else null. */
export const validDay = (raw: string | null): string | null =>
  raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) && addDays(raw, 0) === raw ? raw : null;

/**
 * The day a day picker shows, kept in the URL (`?day=`, replacing the history entry) so it can be linked. `day` is
 * always the requested day, never the day of a response that may still be the previous one: pages compare the two to
 * dim what is still loading. Without `?day=` (or when it is `defaultDay`) the day is `defaultDay`; `picked` is the
 * day from the URL only.
 */
export function useDayParam(defaultDay: string | null) {
  const [params, setParams] = useSearchParams();
  const picked = validDay(params.get('day'));
  const setDay = useCallback(
    (day: string) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (day === defaultDay) next.delete('day');
          else next.set('day', day);
          return next;
        },
        { replace: true },
      ),
    [setParams, defaultDay],
  );
  return { day: picked ?? defaultDay, picked, setDay };
}

export type RangeKey = '30d' | '90d' | '6m' | '1y' | '2y' | 'all';

export const RANGE_KEYS: RangeKey[] = ['30d', '90d', '6m', '1y', '2y', 'all'];

const RANGE_DAYS: Record<RangeKey, number | null> = {
  '30d': 30,
  '90d': 90,
  '6m': 183,
  '1y': 365,
  '2y': 730,
  all: null,
};

export interface DayRange {
  fromDay: string | undefined;
  toDay: string | undefined;
  /** Number of days covered (null while the data range is unknown). */
  days: number | null;
}

/** Resolve a range preset against the data (`asOf` = latest data day). */
export function resolveRange(range: RangeKey, asOf: string | null | undefined, firstDay: string | null | undefined): DayRange {
  const to = asOf ?? todayKey();
  const n = RANGE_DAYS[range];
  const from = n === null ? (firstDay ?? undefined) : addDays(to, -(n - 1));
  const clipped = from && firstDay && from < firstDay ? firstDay : from;
  return { fromDay: clipped, toDay: to, days: clipped ? diffDays(clipped, to) + 1 : null };
}

/** Range preset persisted per page + the resolved day bounds. */
export function useRange(storageKey: string, initial: RangeKey) {
  const [range, setRange] = useStoredState<RangeKey>(`health.${storageKey}.range`, initial);
  const meta = useHealthMeta();
  const bounds = useMemo(
    () => resolveRange(range, meta.data?.asOf, meta.data?.firstDay),
    [range, meta.data?.asOf, meta.data?.firstDay],
  );
  return { range, setRange, meta, ...bounds };
}
