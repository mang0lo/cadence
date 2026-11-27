import { describe, expect, it } from 'vitest';
import { monthColumns } from '@/components/charts/calendar';

const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const labels = (from: string, to: string, weekStart: 0 | 1 = 1) =>
  monthColumns(from, to, weekStart).map((m) => `${NAMES[m.month]}@${m.col}`);

describe('calendar heatmap month labels', () => {
  it('label the month that fills the first columns, not the sliver before it', () => {
    // the dashboard's 18 weeks on 2026-11-25: Jul 27 – Nov 24, August fills columns 1–4 but had no label
    expect(labels('2026-07-27', '2026-11-24')).toEqual(['Aug@1', 'Sep@5', 'Oct@9', 'Nov@14']);
  });

  it('put each month over the first week that is mostly in it', () => {
    // Sep 1 2026 is a Tuesday: that week (Aug 31 – Sep 6) is September's; Nov 1 is a Sunday: its week is October's
    expect(labels('2026-06-01', '2026-11-30')).toEqual(['Jun@0', 'Jul@4', 'Aug@9', 'Sep@13', 'Oct@17', 'Nov@22']);
    // weeks from Sunday: Jun 28 – Jul 4 is July's (Wednesday Jul 1)
    expect(labels('2026-06-07', '2026-10-31', 0)).toEqual(['Jun@0', 'Jul@3', 'Aug@8', 'Sep@12', 'Oct@17']);
  });

  it('keep the first label when its month has room and start mid-week ranges with their own month', () => {
    // Jul 9 is a Thursday: the first column only holds Jul 9–12, and July runs on for three more weeks
    expect(labels('2026-07-09', '2026-10-15')).toEqual(['Jul@0', 'Aug@4', 'Sep@8', 'Oct@12']);
  });

  it('leave out a month that only begins in the last column (no room for its name)', () => {
    expect(labels('2026-08-03', '2026-10-01')).toEqual(['Aug@0', 'Sep@4']);
    // across the turn of the year; February would only start in the last column
    expect(labels('2025-12-01', '2026-02-26')).toEqual(['Dec@0', 'Jan@4', 'Feb@9']);
    expect(labels('2025-12-01', '2026-02-05')).toEqual(['Dec@0', 'Jan@4']);
  });
});
