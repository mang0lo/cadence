import { useMemo } from 'react';
import type { DailyMetric, HealthMeta, RecordTypeInfo } from '@cadence/shared';
import { useApi } from '@/lib/api';
import { useStoredState } from '@/lib/storage';
import { addDays, diffDays, todayKey } from '@/lib/time';

/** Latest data day, first data day, sleep goal … — anchors all "last N days" ranges to the data, not to today. */
export function useHealthMeta() {
  return useApi<HealthMeta>(['health', 'meta'], '/health/meta', undefined, { staleTime: 30_000 });
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
