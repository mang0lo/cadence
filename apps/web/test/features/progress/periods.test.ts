/** Period helpers of the progress pages (apps/web/src/features/progress/periods.ts). */
import { describe, expect, it } from 'vitest';
import { recordScopeStart, scopedTop } from '@/features/progress/periods';

/** An attempt at a local wall-clock time ('YYYY-MM-DDTHH:MM') in a zone `tzMin` minutes east of UTC. */
const at = (local: string, elapsedS: number, tzMin = 60, workoutId = elapsedS) => ({
  workoutId,
  startTs: Date.parse(`${local}:00Z`) / 1000 - tzMin * 60,
  tzMin,
  elapsedS,
  avgHr: null,
});

describe('records scopes', () => {
  it('start where the server starts them', () => {
    expect(recordScopeStart('allTime', '2026-11-26')).toBeNull();
    expect(recordScopeStart('thisYear', '2026-11-26')).toBe('2026-01-01');
    expect(recordScopeStart('last12m', '2026-11-26')).toBe('2025-11-27');
    expect(recordScopeStart('last12m', '2024-02-29')).toBe('2023-03-01');
  });

  it('rank the fastest attempts of a scope by their local day', () => {
    const attempts = [
      at('2024-05-01T08:00', 1250),
      at('2025-12-31T23:30', 1300), // New Year's Eve, local time: last year
      at('2026-01-01T00:30', 1400), // New Year's Day just after midnight: this year
      at('2026-03-01T09:00', 1350),
      at('2026-06-01T09:00', 1350, 60, 99), // tie: the earlier attempt ranks first
      at('2026-12-01T09:00', 1200), // after today
    ];
    const top = scopedTop(attempts, 'thisYear', '2026-11-26');
    expect(top.map((a) => [a.elapsedS, a.rank])).toEqual([
      [1350, 1],
      [1350, 2],
      [1400, 3],
    ]);
    expect(top[1]!.workoutId).toBe(99);
    expect(scopedTop(attempts, 'last12m', '2026-11-26').map((a) => a.elapsedS)).toEqual([1300, 1350, 1350, 1400]);
    expect(scopedTop(attempts, 'thisYear', '2026-11-26', 2)).toHaveLength(2);
  });
});
