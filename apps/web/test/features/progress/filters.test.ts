/** URL filters of the progress pages (apps/web/src/features/progress/useFilters.ts). */
import { describe, expect, it } from 'vitest';
import { urlSport } from '@/features/progress/useFilters';

describe('progress URL filters', () => {
  it('passes on only sport keys the app knows', () => {
    expect(urlSport('run')).toBe('run');
    expect(urlSport('nordic_ski')).toBe('nordic_ski');
    // an old or hand-edited link: the server would answer 400 (or 500 for prototype keys) and the page had no picker
    for (const s of ['running', 'Run', 'constructor', 'toString', '__proto__', 'hasOwnProperty', '', 'all'])
      expect(urlSport(s), s).toBeNull();
    expect(urlSport(null)).toBeNull();
  });
});
