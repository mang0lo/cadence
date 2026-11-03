import type { DataSourcesInfo } from '@cadence/shared';
import { useApi } from './api';
import { useSettings } from './settings';

/**
 * Which watch the athlete uses and which data exists (GET /api/sources). Pages and the navigation use it to leave out
 * what cannot have data for this athlete (e.g. ECG or body measurements for a COROS-only athlete) instead of showing
 * empty cards. Refreshed after every import (query keys under 'core' are invalidated when a job finishes).
 */
export function useDataSources() {
  const { status } = useSettings();
  const authed = !!status && (!status.authRequired || status.authenticated);
  return useApi<DataSourcesInfo>(['core', 'sources'], authed ? '/sources' : null, undefined, {
    staleTime: 30_000,
  });
}

/** True while unknown (still loading), so nothing flickers away; then whether the record type has values. */
export function useHasMetric(): (identifier: string) => boolean {
  const q = useDataSources();
  const set = q.data ? new Set(q.data.metrics) : null;
  return (identifier) => !set || set.has(identifier);
}

const BODY = [
  'BodyMass',
  'BodyMassIndex',
  'BodyFatPercentage',
  'LeanBodyMass',
  'Height',
  'WaistCircumference',
].map((s) => `HKQuantityTypeIdentifier${s}`);

export const hasBodyData = (s: DataSourcesInfo) => s.metrics.some((m) => BODY.includes(m));
