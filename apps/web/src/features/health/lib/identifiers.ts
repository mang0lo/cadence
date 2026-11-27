import { APPLE_HEART_METRICS, type HealthMeta } from '@cadence/shared';

/**
 * HealthKit identifiers the health pages read by name, in one place (shared with the server). Metrics a watch can
 * replace (COROS resting HR, HRV, VO₂max, steps) are not read from here but from `useHeartMetrics()`, which follows the
 * server's choice.
 */
export { HK } from '@cadence/shared';

/** Apple's keys of the metrics the server may swap for the watch's own (`HealthMeta.metrics`, server core/sources.ts). */
export const APPLE_METRICS: HealthMeta['metrics'] = APPLE_HEART_METRICS;
