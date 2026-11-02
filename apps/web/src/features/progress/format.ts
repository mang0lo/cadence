import {
  M_PER_FT,
  sportInfo,
  type ProgressTotals,
  type ProgressTrendMetric,
  type ProgressVolumeMetric,
} from '@cadence/shared';
import { clock, type Formatter } from '@/lib/format';
import type { TFunction } from '@/lib/i18n';

// ---------------------------------------------------------------------------
// Volume metrics (distance / time / elevation / count / effort)
// ---------------------------------------------------------------------------

/** Canonical value of a volume metric in a totals object. */
export function totalsValue(t: ProgressTotals | undefined, metric: ProgressVolumeMetric): number {
  if (!t) return 0;
  switch (metric) {
    case 'distance':
      return t.distanceM;
    case 'time':
      return t.movingS;
    case 'elevation':
      return t.elevationM;
    case 'count':
      return t.count;
    case 'effort':
      return t.effort;
  }
}

/** Canonical value → number shown on a chart axis (km/mi, hours, m/ft, count, effort). */
export function volumeChartValue(fmt: Formatter, metric: ProgressVolumeMetric, v: number): number {
  switch (metric) {
    case 'distance':
      return fmt.distanceValue(v);
    case 'time':
      return v / 3600;
    case 'elevation':
      return fmt.units === 'imperial' ? v / M_PER_FT : v;
    default:
      return v;
  }
}

/** Axis unit of a volume metric ('' for counts). */
export function volumeUnit(fmt: Formatter, metric: ProgressVolumeMetric): string {
  switch (metric) {
    case 'distance':
      return fmt.distanceUnit;
    case 'time':
      return 'h';
    case 'elevation':
      return fmt.units === 'imperial' ? 'ft' : 'm';
    default:
      return '';
  }
}

/** Fully formatted value of a volume metric. */
export function formatVolume(fmt: Formatter, metric: ProgressVolumeMetric, v: number): string {
  switch (metric) {
    case 'distance':
      return fmt.distance(v);
    case 'time':
      return fmt.durationShort(v);
    case 'elevation':
      return fmt.elevation(v);
    default:
      return fmt.int(v);
  }
}

/** Axis tick label of a volume chart value (already converted with volumeChartValue). */
export function volumeAxisLabel(fmt: Formatter, metric: ProgressVolumeMetric, n: number): string {
  if (metric === 'time') return `${fmt.num(n, n < 10 && n % 1 ? 1 : 0)} h`;
  return Math.abs(n) >= 10_000 ? fmt.compact(n) : fmt.num(n, Math.abs(n) < 10 && n % 1 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Per-activity trend metrics
// ---------------------------------------------------------------------------

export interface TrendFormat {
  /** Canonical value → chart value. */
  toChart: (v: number) => number;
  /** Chart value → axis tick label. */
  axisLabel: (n: number) => string;
  /** Canonical value → text with unit. */
  format: (v: number) => string;
  /** Short unit for axis names. */
  unit: string;
  /** Pace axes run inverted so that faster is up. */
  inverse: boolean;
  /** Signed difference between two canonical values, e.g. '−0:12 /km', '+3 bpm'. */
  delta: (from: number, to: number) => string;
}

function numberFormat(fmt: Formatter, unit: string, digits: number, scale = 1): TrendFormat {
  const withUnit = (s: string) => (unit ? `${s} ${unit}` : s);
  return {
    toChart: (v) => v * scale,
    axisLabel: (n) => fmt.num(n, digits),
    format: (v) => withUnit(fmt.num(v * scale, digits)),
    unit,
    inverse: false,
    delta: (a, b) => withUnit(fmt.signed((b - a) * scale, digits)),
  };
}

/** Speed metric of a sport: pace (min/km, min/100 m) or speed (km/h, mph). */
export function speedFormat(fmt: Formatter, sport: string): TrendFormat {
  const mode = sportInfo(sport).speedMode;
  const imperial = fmt.units === 'imperial';
  if (mode === 'pace' || mode === 'pace100') {
    const per = mode === 'pace100' ? (imperial ? 91.44 : 100) : fmt.paceSeconds(1);
    const unit = fmt.paceParts(1, sport).unit;
    const secs = (v: number) => per / v;
    return {
      toChart: secs,
      axisLabel: (n) => clock(n),
      format: (v) => fmt.pace(v, sport),
      unit,
      inverse: true,
      delta: (a, b) => {
        const d = secs(b) - secs(a);
        return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${clock(Math.abs(d))} ${unit}`;
      },
    };
  }
  const k = imperial ? 3600 / 1609.344 : 3.6;
  return numberFormat(fmt, imperial ? 'mph' : 'km/h', 1, k);
}

export function trendFormat(fmt: Formatter, t: TFunction, metric: ProgressTrendMetric, sport: string): TrendFormat {
  const imperial = fmt.units === 'imperial';
  switch (metric) {
    case 'speed':
      return speedFormat(fmt, sport);
    case 'hr':
      return numberFormat(fmt, 'bpm', 0);
    case 'ef':
      return numberFormat(fmt, t('progress.units.perBeat', { unit: imperial ? 'ft' : 'm' }), 2, imperial ? 1 / M_PER_FT : 1);
    case 'cadence':
      return numberFormat(fmt, sportInfo(sport).group === 'cycle' ? 'rpm' : 'spm', 0);
    case 'power':
      return numberFormat(fmt, 'W', 0);
    case 'stride':
      return numberFormat(fmt, imperial ? 'ft' : 'm', 2, imperial ? 1 / M_PER_FT : 1);
    case 'gct':
      return numberFormat(fmt, 'ms', 0);
    case 'vo':
      return numberFormat(fmt, imperial ? 'in' : 'cm', 1, imperial ? 1 / 0.0254 : 100);
    case 'decoupling':
      return numberFormat(fmt, '%', 1);
  }
}

/** "+11.9 %" for relative changes; absolute changes use the metric's own unit. `unsigned` drops the sign. */
export function formatChange(
  fmt: Formatter,
  change: number,
  kind: 'relative' | 'absolute',
  tf: TrendFormat,
  unsigned = false,
): string {
  if (kind === 'relative') return unsigned ? `${fmt.num(Math.abs(change) * 100, 1)} %` : `${fmt.signed(change * 100, 1)} %`;
  return unsigned ? tf.format(Math.abs(change)) : tf.delta(0, change);
}
