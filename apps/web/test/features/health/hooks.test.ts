import { describe, expect, it } from 'vitest';
import { resolveRange, validDay } from '@/features/health/lib/hooks';

describe('health day helpers', () => {
  it('accepts only real calendar days from the URL', () => {
    expect(validDay('2025-03-30')).toBe('2025-03-30');
    expect(validDay('2024-02-29')).toBe('2024-02-29');
    expect(validDay('2025-02-29')).toBeNull();
    expect(validDay('2025-13-01')).toBeNull();
    expect(validDay('2025-3-30')).toBeNull();
    expect(validDay('yesterday')).toBeNull();
    expect(validDay(null)).toBeNull();
  });

  it('anchors ranges to the data and clips them to the first day', () => {
    expect(resolveRange('30d', '2026-11-24', '2024-11-24')).toEqual({ fromDay: '2026-10-26', toDay: '2026-11-24', days: 30 });
    expect(resolveRange('2y', '2026-11-24', '2025-06-01')).toEqual({ fromDay: '2025-06-01', toDay: '2026-11-24', days: 542 });
    expect(resolveRange('all', '2026-11-24', '2024-11-24')).toEqual({ fromDay: '2024-11-24', toDay: '2026-11-24', days: 731 });
  });
});
