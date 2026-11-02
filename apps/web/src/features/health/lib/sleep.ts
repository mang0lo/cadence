import {
  mean,
  midnightOffsetMin,
  minutesOfDay,
  stdev,
  type SleepNight,
  type SleepStage,
} from '@cadence/shared';
import type { ChartTheme } from '@/components/charts/theme';

/** Stacking order (bottom → top). Deep sleep sits at the bottom, awake time on top. */
export const STAGE_STACK: SleepStage[] = ['deep', 'core', 'rem', 'asleep', 'awake'];

/**
 * Sleep stages are an ordered depth scale, so they use one blue ramp (deep = most salient step) and awake time gets
 * the orange accent of the palette. Fixed per stage — never by rank.
 */
export function stageColor(theme: ChartTheme, stage: SleepStage): string {
  switch (stage) {
    case 'deep':
      return theme.seqBlue[4]!;
    case 'core':
      return theme.seqBlue[2]!;
    case 'rem':
      return theme.seqBlue[0]!;
    case 'asleep':
      return theme.seqBlue[1]!;
    default:
      return theme.series[0]!;
  }
}

export function stageSeconds(n: SleepNight, stage: SleepStage): number {
  switch (stage) {
    case 'deep':
      return n.deepS;
    case 'core':
      return n.coreS;
    case 'rem':
      return n.remS;
    case 'asleep':
      return n.unspecS;
    default:
      return n.awakeS;
  }
}

export interface ScheduleStats {
  /** Mean bedtime as offset from midnight in minutes (negative = before midnight). */
  bed: number | null;
  /** Mean wake-up as minutes after midnight. */
  wake: number | null;
  /** Sample standard deviations in minutes. */
  bedSd: number | null;
  wakeSd: number | null;
}

export const bedOffset = (n: SleepNight): number => midnightOffsetMin(n.bedTs, n.tzBedMin);
export const wakeOffset = (n: SleepNight): number => minutesOfDay(n.wakeTs, n.tzWakeMin);

export function scheduleStats(nights: SleepNight[]): ScheduleStats {
  const bed = nights.map(bedOffset);
  const wake = nights.map(wakeOffset);
  return { bed: mean(bed), wake: mean(wake), bedSd: stdev(bed), wakeSd: stdev(wake) };
}

/** Minutes after midnight (may be negative or ≥ 1440) → minutes of the day 0..1439. */
export const wrapMinutes = (m: number): number => ((Math.round(m) % 1440) + 1440) % 1440;

/** Nights with sleep tracking (asleep time known). */
export const tracked = (nights: SleepNight[]): SleepNight[] => nights.filter((n) => n.kind === 'night' && n.asleepS > 0);
