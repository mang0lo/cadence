/** Chart helpers of the progress feature (apps/web/src/features/progress/chart.ts). */
import { describe, expect, it } from 'vitest';
import { fitEnds, msDay } from '@/features/progress/chart';
import { createFormatter } from '@/lib/format';

const en = createFormatter('metric', 'en-US', 'en');

describe('fitEnds', () => {
  it('places a trend at the local times of its first and last workout', () => {
    // New York: the first run on Jan 31 at 19:30 local is Feb 1 00:30 UTC; the last one on Jun 30 at 21:00 (summer time)
    const first = Date.UTC(2026, 1, 1, 0, 30) / 1000;
    const last = Date.UTC(2026, 6, 1, 1, 0) / 1000;
    const workouts = [{ tzMin: -300 }, { tzMin: -240 }, { tzMin: -240 }];
    const points: [number, number][] = [
      [0, 3.1],
      [1, 3.2],
      [2, 3.3],
    ];
    const [x0, x1] = fitEnds(workouts, points, { startTs: first, endTs: last });
    expect(msDay(x0)).toBe('2026-01-31');
    expect(msDay(x1)).toBe('2026-06-30');
    expect(en.day(msDay(x0), 'monthYear')).toBe('Jan 2026');
    expect(new Date(x1).toISOString()).toBe('2026-06-30T21:00:00.000Z');
  });
});
