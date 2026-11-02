import type { DailyMetric } from '@cadence/shared';
import type { TrendPoint } from '../components/TrendChart';

/** daily_metrics rows → chart points (day, daily value, min / max of the day's samples). */
export const toPoints = (rows: DailyMetric[] | undefined): TrendPoint[] =>
  (rows ?? []).map((r) => ({ day: r.day, value: r.value, min: r.min, max: r.max }));
