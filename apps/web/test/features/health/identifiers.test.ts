import { describe, expect, it } from 'vitest';
import { metricDef } from '@cadence/shared';
import { APPLE_METRICS, HK } from '@/features/health/lib/identifiers';

describe('health identifiers', () => {
  it('only names record types of the catalogue', () => {
    for (const id of [...Object.values(HK), ...Object.values(APPLE_METRICS)]) expect(metricDef(id), id).toBeTruthy();
  });
});
