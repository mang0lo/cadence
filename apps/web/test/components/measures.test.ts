/**
 * The measure color registry (apps/web/src/components/charts/measures.ts): one color per health measure on the Health
 * pages and the progress fitness charts (resting HR, HRV, VO2max), by identity and never by rank.
 */
import { describe, expect, it } from 'vitest';
import { MEASURE_SLOTS, measureColor } from '@/components/charts/measures';
import type { ChartTheme } from '@/components/charts/theme';
import { identifierColor } from '@/features/health/lib/colors';

const theme = { series: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'] } as unknown as ChartTheme;

describe('measure colors', () => {
  it('keeps the slots the measures always had', () => {
    expect(measureColor(theme, 'restingHr')).toBe('c8');
    expect(measureColor(theme, 'hrv')).toBe('c7');
    expect(measureColor(theme, 'vo2max')).toBe('c2');
    expect(Object.values(MEASURE_SLOTS).every((s) => s >= 1 && s <= 8)).toBe(true);
  });

  it('gives a record type the color of its measure', () => {
    expect(identifierColor(theme, 'HKQuantityTypeIdentifierRestingHeartRate')).toBe(measureColor(theme, 'restingHr'));
    expect(identifierColor(theme, 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN')).toBe(measureColor(theme, 'hrv'));
    expect(identifierColor(theme, 'HKQuantityTypeIdentifierVO2Max')).toBe(measureColor(theme, 'vo2max'));
  });
});
