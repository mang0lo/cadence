import { describe, expect, it } from 'vitest';
import { APPLE_HEART_METRICS, HK as SHARED_HK, periodKeys as sharedPeriodKeys, periodStart as sharedPeriodStart } from '@cadence/shared';
import { APPLE_METRICS, HK } from '@/features/health/lib/identifiers';
import { periodKeys, periodStart } from '@/features/health/lib/periods';

/** The health pages read the identifiers, the heart metrics and the periods the server uses (@cadence/shared). */
describe('health helpers shared with the server', () => {
  it('uses the shared identifiers and heart metric keys', () => {
    expect(HK).toBe(SHARED_HK);
    expect(APPLE_METRICS).toEqual(APPLE_HEART_METRICS);
  });

  it('uses the shared periods', () => {
    expect(periodStart).toBe(sharedPeriodStart);
    expect(periodKeys).toBe(sharedPeriodKeys);
  });
});
