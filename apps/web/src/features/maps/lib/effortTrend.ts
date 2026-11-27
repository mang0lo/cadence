import { speedFormat, type Formatter } from '@/lib/format';

/** One effort on a route or segment, as the trend chart needs it. */
export interface TrendEffort {
  startTs: number;
  tzMin: number;
  timeS: number;
  avgSpeed: number | null;
  avgHr: number | null;
  rank: number;
}

export type EffortMetric = 'time' | 'pace';

export interface EffortScale {
  /** Chart value of an effort: seconds, pace in seconds per km / mi / 100 m / 100 yd, or km/h / mph; null without data. */
  value: (e: TrendEffort) => number | null;
  /** Axis tick of a chart value. */
  axisLabel: (v: number) => string;
  /** Chart value with its unit (tooltip, table). */
  label: (v: number) => string;
  /** Times and paces: lower is better (the axis runs inverted, so better is up). */
  lowerIsBetter: boolean;
  /**
   * Smallest axis step: what the labels resolve (whole seconds, a tenth of km/h or mph). Efforts seconds apart made
   * ECharts step by 0.5 s, and the labels read 1:01:40, 1:01:41, 1:01:41, 1:01:42, 1:01:42.
   */
  minInterval: number;
}

/**
 * How the effort trend shows a metric. Pace and speed come from speedFormat (the progress charts use it too): swims
 * per 100 m / 100 yd, runs per km / mi, rides in km/h / mph.
 */
export function effortScale(fmt: Formatter, sport: string, metric: EffortMetric): EffortScale {
  if (metric === 'time') {
    const clock = (v: number) => fmt.duration(v);
    return { value: (e) => e.timeS, axisLabel: clock, label: clock, lowerIsBetter: true, minInterval: 1 };
  }
  const sf = speedFormat(fmt, sport);
  return {
    value: (e) => (e.avgSpeed == null || !(e.avgSpeed > 0) ? null : sf.toChart(e.avgSpeed)),
    axisLabel: (v) => sf.axisLabel(v),
    label: (v) => `${sf.axisLabel(v)} ${sf.unit}`,
    lowerIsBetter: sf.inverse,
    // paces are labelled in whole seconds (m:ss), speeds with one decimal
    minInterval: sf.inverse ? 1 : 0.1,
  };
}

/** Points of the efforts (oldest first) and the running best as [ms, value] pairs for the chart. */
export function effortSeries(
  asc: TrendEffort[],
  scale: Pick<EffortScale, 'value' | 'lowerIsBetter'>,
): { points: [number, number | null][]; bestSoFar: [number, number][] } {
  const points: [number, number | null][] = [];
  const bestSoFar: [number, number][] = [];
  let best: number | null = null;
  for (const e of asc) {
    const v = scale.value(e);
    points.push([e.startTs * 1000, v]);
    if (v != null) {
      best = best === null ? v : scale.lowerIsBetter ? Math.min(best, v) : Math.max(best, v);
      bestSoFar.push([e.startTs * 1000, best]);
    }
  }
  return { points, bestSoFar };
}
