// Which sports show a pace, and their "Pace" / "Speed" label, are the app-wide rule in lib/format.ts (showsPace,
// speedLabelKey).

export type EffortSortCol = 'date' | 'time' | 'pace' | 'hr' | 'rank';
export interface EffortSort {
  col: EffortSortCol;
  dir: 'asc' | 'desc';
}

export interface SortableEffort {
  startTs: number;
  timeS: number;
  avgSpeed: number | null;
  avgHr: number | null;
  rank: number;
}

/**
 * Sort value of a column. The pace column sorts by what it shows: pace (seconds per distance) for pace sports, speed
 * for the others; efforts without a speed are the slowest.
 */
export function effortSortKey(e: SortableEffort, col: EffortSortCol, pace: boolean): number {
  switch (col) {
    case 'date':
      return e.startTs;
    case 'time':
      return e.timeS;
    case 'pace':
      if (!e.avgSpeed || e.avgSpeed <= 0) return pace ? Infinity : 0;
      return pace ? 1 / e.avgSpeed : e.avgSpeed;
    case 'hr':
      return e.avgHr ?? 0;
    case 'rank':
      return e.rank;
  }
}

/** First direction when a column is picked: newest first, fastest first (lowest pace / highest speed), else ascending. */
export function defaultSortDir(col: EffortSortCol, pace: boolean): 'asc' | 'desc' {
  if (col === 'date') return 'desc';
  if (col === 'pace') return pace ? 'asc' : 'desc';
  return 'asc';
}

/** Rows sorted by a column (ties: oldest first, reversed with the rest for 'desc'). */
export function sortEfforts<T extends SortableEffort>(rows: readonly T[], sort: EffortSort, pace: boolean): T[] {
  const key = (e: T) => effortSortKey(e, sort.col, pace);
  const list = [...rows].sort((a, b) => key(a) - key(b) || a.startTs - b.startTs);
  return sort.dir === 'desc' ? list.reverse() : list;
}
