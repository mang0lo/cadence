/** Routes list filters (apps/web/src/features/maps/lib/routeName.ts). */
import { describe, expect, it } from 'vitest';
import { activeRouteSport } from '@/features/maps/lib/routeName';

describe('routes list sport filter', () => {
  it('falls back to all sports when the picked sport has no routes at the new minimum (its chip is gone)', () => {
    // hikes done 2-4 times: 'Hike' picked at 2×+, then 5×+ leaves only runs
    expect(activeRouteSport('hike', ['run', 'hike'])).toBe('hike');
    expect(activeRouteSport('hike', ['run'])).toBe('all');
    expect(activeRouteSport('hike', [])).toBe('all'); // loading, or no routes at all
    expect(activeRouteSport('all', ['run'])).toBe('all');
  });
});
