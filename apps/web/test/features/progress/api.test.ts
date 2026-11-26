/** Cache handling of the progress API hooks (apps/web/src/features/progress/api.ts). */
import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { PaceAtHrResponse } from '@cadence/shared';
import { applySavedHrBand } from '@/features/progress/api';

const response = (band: { lo: number; hi: number }, saved?: { lo: number; hi: number }): PaceAtHrResponse => ({
  sport: 'run',
  band,
  suggestions: [...(saved ? [{ key: 'saved' as const, ...saved }] : []), { key: 'common', lo: 140, hi: 150 }, { key: 'z2', lo: 125, hi: 141 }],
  hrDistribution: { lo: 100, seconds: [1, 2, 3] },
  months: [],
  fit: null,
  change: null,
  minSeconds: 600,
});

describe('saving a heart-rate band', () => {
  it('shows the saved band without fetching the shown band again', async () => {
    const qc = new QueryClient();
    const range = { fromDay: '2026-01-01', toDay: '2026-11-26' };
    const picked = ['progress', 'pace-at-hr', { sport: 'run', ...range, lo: 130, hi: 140 }];
    const byDefault = ['progress', 'pace-at-hr', { sport: 'run', ...range, lo: undefined, hi: undefined }];
    const ride = ['progress', 'pace-at-hr', { sport: 'ride', ...range, lo: 120, hi: 130 }];
    qc.setQueryData(picked, response({ lo: 130, hi: 140 }, { lo: 150, hi: 160 }));
    qc.setQueryData(byDefault, response({ lo: 150, hi: 160 }, { lo: 150, hi: 160 }));
    qc.setQueryData(ride, { ...response({ lo: 120, hi: 130 }), sport: 'ride' });

    await applySavedHrBand(qc, 'run', { lo: 130, hi: 140 });

    // the shown response lists the new band as 'saved' (first, like the server) and stays fresh
    expect(qc.getQueryData<PaceAtHrResponse>(picked)!.suggestions).toEqual([
      { key: 'saved', lo: 130, hi: 140 },
      { key: 'common', lo: 140, hi: 150 },
      { key: 'z2', lo: 125, hi: 141 },
    ]);
    expect(qc.getQueryState(picked)!.isInvalidated).toBe(false);
    // a response without an explicit band used the old saved band as its default: it must be fetched again
    expect(qc.getQueryState(byDefault)!.isInvalidated).toBe(true);
    // other sports keep their own saved band
    expect(qc.getQueryData<PaceAtHrResponse>(ride)!.suggestions.some((s) => s.key === 'saved')).toBe(false);
    expect(qc.getQueryState(ride)!.isInvalidated).toBe(false);
  });
});
