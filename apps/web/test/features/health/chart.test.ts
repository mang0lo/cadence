import { describe, expect, it } from 'vitest';
import { numAxisLabel, tickDigits } from '@/features/health/lib/chart';
import { createFormatter } from '@/lib/format';

describe('health chart helpers', () => {
  it('gives every tick only the decimals it needs', () => {
    expect(tickDigits(0)).toBe(0);
    expect(tickDigits(6000)).toBe(0);
    expect(tickDigits(-2)).toBe(0);
    expect(tickDigits(0.5)).toBe(1);
    expect(tickDigits(0.1 + 0.2)).toBe(1); // 0.30000000000000004
    expect(tickDigits(96.5)).toBe(1);
    expect(tickDigits(0.25)).toBe(2);
    expect(tickDigits(1 / 3)).toBe(3);
  });

  it('formats value-axis ticks with the separators of the locale', () => {
    const de = numAxisLabel(createFormatter('metric', 'de-DE', 'de'));
    expect(de(6000)).toBe('6.000');
    expect(de(0.5)).toBe('0,5');
    expect(de(14.5)).toBe('14,5');
    expect(de(0)).toBe('0');
    const en = numAxisLabel(createFormatter('metric', 'en-US', 'en'));
    expect(en(6000)).toBe('6,000');
    expect(en(0.25)).toBe('0.25');
    // 0-digit labels would print 0.5 and 1 both as "1"
    expect(new Set([0, 0.5, 1, 1.5].map(de)).size).toBe(4);
  });
});
