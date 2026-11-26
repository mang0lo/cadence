/**
 * Streak math (pure, unit-tested). Input are local active days ('YYYY-MM-DD'); duplicates and order
 * do not matter. A day that has not happened yet never breaks a streak: when `asOf` itself is not
 * active (yet) the streak is still alive through the day before (`pending = true`). The same holds
 * for the week containing `asOf` in weekly streaks.
 */
import type { StreakInfo, WeeklyStreakInfo } from '@cadence/shared';
import { DAY_RE, epoch, fromEpoch, weekStartEpoch } from './days';

export interface Run {
  start: string;
  end: string;
  length: number;
}

interface NumRun {
  start: number;
  end: number;
  length: number;
}

/** Sorted unique epoch days (≤ upTo when given). */
function toEpochs(days: Iterable<string>, upTo?: number): number[] {
  const set = new Set<number>();
  for (const d of days) {
    if (!DAY_RE.test(d)) continue;
    const e = epoch(d);
    if (upTo === undefined || e <= upTo) set.add(e);
  }
  return [...set].sort((a, b) => a - b);
}

/** Maximal runs of a sorted list where consecutive members differ by `step`. */
function runsOf(sorted: number[], step: number): NumRun[] {
  const out: NumRun[] = [];
  let start: number | null = null;
  let prev = 0;
  for (const x of sorted) {
    if (start !== null && x === prev + step) {
      prev = x;
      continue;
    }
    if (start !== null) out.push({ start, end: prev, length: (prev - start) / step + 1 });
    start = x;
    prev = x;
  }
  if (start !== null) out.push({ start, end: prev, length: (prev - start) / step + 1 });
  return out;
}

/** Longest run; on ties the most recent one. */
function longestOf(runs: NumRun[]): NumRun | null {
  let best: NumRun | null = null;
  for (const r of runs) if (!best || r.length >= best.length) best = r;
  return best;
}

/** Maximal runs of consecutive days, oldest first. */
export function dayRuns(days: Iterable<string>): Run[] {
  return runsOf(toEpochs(days), 1).map((r) => ({ start: fromEpoch(r.start), end: fromEpoch(r.end), length: r.length }));
}

/** Day on which a run of `n` consecutive days was first completed (null if never). */
export function firstDayReaching(runs: Run[], n: number): string | null {
  for (const r of runs) if (r.length >= n) return fromEpoch(epoch(r.start) + n - 1);
  return null;
}

/** Current and longest daily streak as of `asOf`. Days after `asOf` are ignored. */
export function dailyStreak(days: Iterable<string>, asOf: string): StreakInfo {
  const today = epoch(asOf);
  const runs = runsOf(toEpochs(days, today), 1);
  const longest = longestOf(runs);
  const last = runs[runs.length - 1];
  const alive = !!last && last.end >= today - 1;
  return {
    current: alive ? last!.length : 0,
    currentStart: alive ? fromEpoch(last!.start) : null,
    longest: longest?.length ?? 0,
    longestStart: longest ? fromEpoch(longest.start) : null,
    longestEnd: longest ? fromEpoch(longest.end) : null,
    pending: alive && last!.end === today - 1,
  };
}

/** Per week (start epoch day) the number of active days, for days ≤ upTo. */
function weekCounts(days: Iterable<string>, weekStart: 0 | 1, upTo?: number): Map<number, number> {
  const counts = new Map<number, number>();
  for (const e of toEpochs(days, upTo)) {
    const w = weekStartEpoch(e, weekStart);
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return counts;
}

/** Runs of consecutive weeks with ≥ minPerWeek active days; start/end are week start days. */
export function weekRuns(days: Iterable<string>, weekStart: 0 | 1, minPerWeek = 1): Run[] {
  const counts = weekCounts(days, weekStart);
  const weeks = [...counts]
    .filter(([, n]) => n >= minPerWeek)
    .map(([w]) => w)
    .sort((a, b) => a - b);
  return runsOf(weeks, 7).map((r) => ({ start: fromEpoch(r.start), end: fromEpoch(r.end), length: r.length }));
}

/**
 * Current and longest weekly streak (consecutive weeks with ≥ minPerWeek active days) as of `asOf`.
 * The week containing `asOf` only extends the streak once it qualifies; until then the streak is
 * alive through the previous week (`pending`). longestEnd is the last day of the run (≤ asOf).
 */
export function weeklyStreak(
  days: Iterable<string>,
  asOf: string,
  weekStart: 0 | 1,
  minPerWeek = 1,
): WeeklyStreakInfo {
  const today = epoch(asOf);
  const min = Math.max(1, Math.round(minPerWeek));
  const counts = weekCounts(days, weekStart, today);
  const weeks = [...counts]
    .filter(([, n]) => n >= min)
    .map(([w]) => w)
    .sort((a, b) => a - b);
  const runs = runsOf(weeks, 7);
  const thisWeek = weekStartEpoch(today, weekStart);
  const last = runs[runs.length - 1];
  const alive = !!last && last.end >= thisWeek - 7;
  const longest = longestOf(runs);
  return {
    current: alive ? last!.length : 0,
    currentStart: alive ? fromEpoch(last!.start) : null,
    longest: longest?.length ?? 0,
    longestStart: longest ? fromEpoch(longest.start) : null,
    longestEnd: longest ? fromEpoch(Math.min(longest.end + 6, today)) : null,
    pending: alive && last!.end === thisWeek - 7,
    thisWeek: counts.get(thisWeek) ?? 0,
    minPerWeek: min,
  };
}

/** Longest run of consecutive days inside [from, to] (for yearly summaries). */
export function longestRunWithin(days: Iterable<string>, from: string, to: string): Run | null {
  const a = epoch(from);
  const b = epoch(to);
  const inside = toEpochs(days).filter((e) => e >= a && e <= b);
  const best = longestOf(runsOf(inside, 1));
  return best ? { start: fromEpoch(best.start), end: fromEpoch(best.end), length: best.length } : null;
}

/**
 * Longest run of qualifying weeks, counting only the days inside [from, to]: a week cut by `from` or `to` counts with
 * its days inside the range, and the run returned is clamped to the range.
 */
export function longestWeekRunWithin(
  days: Iterable<string>,
  from: string,
  to: string,
  weekStart: 0 | 1,
  minPerWeek = 1,
): Run | null {
  const a = epoch(from);
  const b = epoch(to);
  const inside = toEpochs(days).filter((e) => e >= a && e <= b);
  const counts = weekCounts(inside.map(fromEpoch), weekStart);
  const weeks = [...counts]
    .filter(([, n]) => n >= minPerWeek)
    .map(([w]) => w)
    .sort((x, y) => x - y);
  const best = longestOf(runsOf(weeks, 7));
  return best
    ? { start: fromEpoch(Math.max(best.start, a)), end: fromEpoch(Math.min(best.end + 6, b)), length: best.length }
    : null;
}
