import { useMemo } from 'react';
import { cssVar, useResolvedTheme } from '@/lib/theme';
import { sportSlot } from '@/lib/sports';

/** Resolved chart colors for the current theme (canvas charts cannot use CSS variables directly). */
export interface ChartTheme {
  dark: boolean;
  font: string;
  surface: string;
  fg: string;
  fg2: string;
  muted: string;
  grid: string;
  axis: string;
  border: string;
  accent: string;
  /** Categorical slots 1..8 (index 0 = slot 1). Assign by entity, in order — never cycle. */
  series: string[];
  other: string;
  /** Sequential orange ramp, 5 steps light→dark (dark→light in dark mode = low→high salience). */
  seq: string[];
  /** Second sequential ramp (blue). */
  seqBlue: string[];
  /** HR zones Z1..Z5. */
  zones: string[];
  diverging: { neg: string; mid: string; pos: string };
  status: { good: string; warning: string; serious: string; critical: string };
  cellEmpty: string;
}

function read(): ChartTheme {
  const v = cssVar;
  const steps = (prefix: string) => [1, 2, 3, 4, 5].map((i) => v(`${prefix}${i}`));
  return {
    dark: document.documentElement.dataset.theme === 'dark',
    font: getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif',
    surface: v('--surface'),
    fg: v('--fg'),
    fg2: v('--fg-2'),
    muted: v('--axis-text'),
    grid: v('--grid'),
    axis: v('--axis'),
    border: v('--border-strong'),
    accent: v('--accent'),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--series-${i}`)),
    other: v('--series-other'),
    seq: steps('--seq-'),
    seqBlue: steps('--seqb-'),
    zones: steps('--zone-'),
    diverging: { neg: v('--div-neg'), mid: v('--div-mid'), pos: v('--div-pos') },
    status: { good: v('--good'), warning: v('--warning'), serious: v('--serious'), critical: v('--critical') },
    cellEmpty: v('--cell-empty'),
  };
}

/** Chart colors, recomputed whenever light/dark changes. */
export function useChartTheme(): ChartTheme {
  const mode = useResolvedTheme();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(read, [mode]);
}

/** Fixed color of a sport in charts (same identity as sportColorVar in the DOM). */
export function sportColor(theme: ChartTheme, sport: string): string {
  const slot = sportSlot(sport);
  return slot ? theme.series[slot - 1]! : theme.other;
}

/** Pick a sequential step (0..4) for a value given ascending thresholds of length 4. */
export function seqStep(value: number, thresholds: number[]): number {
  let i = 0;
  while (i < thresholds.length && value > thresholds[i]!) i++;
  return Math.min(i, 4);
}
