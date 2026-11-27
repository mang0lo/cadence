import { addDays, diffDays, startOfWeek } from '@/lib/time';

export interface MonthColumn {
  /** 0 = January. */
  month: number;
  /** Week column the label starts at. */
  col: number;
}

/**
 * Month labels above the week columns of a calendar heatmap. A column belongs to the month of most of its days (its
 * middle day, within the range) and a month is labelled at its first column. A month with only a sliver in view at
 * the start loses its label when it would run into the next one, and a month that only begins in the last column has
 * no room for one.
 */
export function monthColumns(from: string, to: string, weekStart: 0 | 1, minGap = 3): MonthColumn[] {
  const gridStart = startOfWeek(from, weekStart);
  const cols = Math.floor(diffDays(gridStart, to) / 7) + 1;
  const out: MonthColumn[] = [];
  let prev = '';
  for (let col = 0; col < cols; col++) {
    let mid = addDays(gridStart, col * 7 + 3);
    if (mid < from) mid = from;
    if (mid > to) mid = to;
    const ym = mid.slice(0, 7);
    if (ym !== prev) out.push({ month: Number(mid.slice(5, 7)) - 1, col });
    prev = ym;
  }
  if (out.length > 1 && out[1]!.col - out[0]!.col < minGap) out.shift();
  if (out.length > 1 && out[out.length - 1]!.col > cols - 2) out.pop();
  return out;
}
