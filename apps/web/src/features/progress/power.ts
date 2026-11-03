/**
 * Helpers of the power curve page (durations, curve names, units). Watts are unit-free; W/kg uses kg in both unit
 * systems (it is the standard in cycling and running).
 */
import {
  PROGRESS_POWER_COMPARES,
  PROGRESS_POWER_PERIODS,
  sportInfo,
  type ProgressDayRange,
  type ProgressPowerCompare,
  type ProgressPowerEffort,
  type ProgressPowerPeriod,
} from '@cadence/shared';
import type { Formatter } from '@/lib/format';
import type { TFunction } from '@/lib/i18n';
import { bucketLabel } from './chart';

/** Tick positions (s) of the logarithmic duration axis. */
export const POWER_TICKS = [1, 5, 15, 60, 300, 1200, 3600, 10800];
/** Durations of the peak power tiles. */
export const KEY_DURATIONS = [5, 60, 300, 1200, 3600];

export type PowerUnit = 'w' | 'wkg';

export const isPowerPeriod = (v: string | null): v is ProgressPowerPeriod =>
  !!v && (PROGRESS_POWER_PERIODS as string[]).includes(v);
export const isPowerCompare = (v: string | null): v is ProgressPowerCompare =>
  !!v && (PROGRESS_POWER_COMPARES as string[]).includes(v);

/** The FTP setting (AthleteSettings.ftp) is cycling power. */
export const isCycling = (sport: string) => sportInfo(sport).group === 'cycle';

/** "5 s", "1 min", "90 s", "20 min", "1 h", "1 h 15 min" (de: "1 Min.", "1 Std. 15 Min."). */
export function durationLabel(t: TFunction, fmt: Formatter, s: number): string {
  if (s < 60 || (s < 600 && s % 60 !== 0)) return t('progress.power.duration.s', { n: fmt.int(s) });
  if (s < 3600) return t('progress.power.duration.min', { n: fmt.num(s / 60, s % 60 ? 1 : 0) });
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m
    ? t('progress.power.duration.hMin', { h: fmt.int(h), m: fmt.int(m) })
    : t('progress.power.duration.h', { n: fmt.int(h) });
}

/** Value of an effort in the chosen unit (null when W/kg is asked for but no body mass is known). */
export const powerValue = (p: ProgressPowerEffort, unit: PowerUnit): number | null =>
  unit === 'wkg' ? p.wkg : p.watts;

/** "255 W" / "3.5 W/kg". */
export function formatPower(fmt: Formatter, v: number, unit: PowerUnit, wkgDigits = 1): string {
  return unit === 'wkg' ? `${fmt.num(v, wkgDigits)} W/kg` : `${fmt.int(v)} W`;
}

export function rangeLabel(fmt: Formatter, r: ProgressDayRange): string {
  if (r.fromDay === r.toDay) return fmt.day(r.fromDay, 'day');
  const sameYear = r.fromDay.slice(0, 4) === r.toDay.slice(0, 4);
  return `${fmt.day(r.fromDay, sameYear ? 'dayShort' : 'day')} – ${fmt.day(r.toDay, 'day')}`;
}

const PERIOD_DAYS: Partial<Record<ProgressPowerPeriod, number>> = { '42d': 42, '90d': 90 };

/** Legend name of a curve: "Last 90 days", "The 90 days before", "2025", "All-time best", a date range. */
export function curveName(
  t: TFunction,
  fmt: Formatter,
  period: ProgressPowerPeriod,
  kind: 'current' | 'previous' | 'allTime',
  r: ProgressDayRange,
): string {
  if (kind === 'allTime') return t('progress.power.series.allTime');
  const days = PERIOD_DAYS[period];
  if (days)
    return t(kind === 'current' ? 'progress.power.series.last' : 'progress.power.series.before', { days });
  if (period === '12m')
    return t(kind === 'current' ? 'progress.power.series.last12m' : 'progress.power.series.before12m');
  if (period === 'year') return r.fromDay.slice(0, 4);
  if (period === 'all') return t('progress.power.periods.all');
  return rangeLabel(fmt, r);
}

/** Label of an FTP history bucket: 'YYYY-MM' → "Jan 2026", 'YYYY-Qn' → "Q1 2026". */
export function historyBucketLabel(t: TFunction, fmt: Formatter, key: string): string {
  const q = /^(\d{4})-Q(\d)$/.exec(key);
  return q ? t('progress.power.history.quarterLabel', { q: q[2]!, year: q[1]! }) : bucketLabel(fmt, key);
}
