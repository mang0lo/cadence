/**
 * Numbers typed by the user, read with the separators of the locale (apps/web/src/lib/format.ts parseNumber,
 * fmt.parseNumber): goal targets, heart rate and power settings, the pace-at-heart-rate band.
 */
import { describe, expect, it } from 'vitest';
import { createFormatter, parseNumber } from '@/lib/format';
import { parseBounds } from '@/features/platform/settings/validate';

describe('parseNumber', () => {
  it('reads thousands separators of the locale instead of taking them for a decimal point', () => {
    expect(parseNumber('1,000', 'en-US')).toBe(1000);
    expect(parseNumber('2,500', 'en-US')).toBe(2500);
    expect(parseNumber('1,000,000', 'en-US')).toBe(1_000_000);
    expect(parseNumber('10.000', 'de-DE')).toBe(10_000);
    expect(parseNumber('1.000', 'de-DE')).toBe(1000);
    expect(parseNumber('10 000', 'de-AT')).toBe(10_000);
    expect(parseNumber("10'000", 'de-CH')).toBe(10_000);
    expect(parseNumber('10’000', 'de-CH')).toBe(10_000);
  });

  it('reads the decimal separator of the locale, and the other one where it cannot group thousands', () => {
    expect(parseNumber('42.195', 'en-US')).toBe(42.195);
    expect(parseNumber('42,195', 'de-DE')).toBe(42.195);
    expect(parseNumber('0,5', 'de-DE')).toBe(0.5);
    expect(parseNumber('1.5', 'de-DE')).toBe(1.5);
    expect(parseNumber('1,5', 'en-US')).toBe(1.5);
    expect(parseNumber('.5', 'en-US')).toBe(0.5);
    expect(parseNumber('1.234,5', 'de-DE')).toBe(1234.5);
    expect(parseNumber('1,234.5', 'de-DE')).toBe(1234.5);
    expect(parseNumber('42.195', 'de-CH')).toBe(42.195);
    expect(parseNumber(' 30 ', 'en-US')).toBe(30);
  });

  it('takes a lone separator before three digits as a decimal point where a decimal is expected', () => {
    // single-activity distances are entered with up to three decimals (the marathon is 42.195 km)
    expect(parseNumber('42.195', 'de-DE', true)).toBe(42.195);
    expect(parseNumber('42,195', 'en-US', true)).toBe(42.195);
    expect(parseNumber('42,195', 'de-DE', true)).toBe(42.195);
  });

  it('rejects malformed numbers', () => {
    for (const s of ['', ' ', 'abc', '-5', '1e3', ',', '1..5', '1,2,3', '1.234.5,6,7', '12,34.5', '5 km'])
      expect(parseNumber(s, 'en-US'), s).toBeNaN();
    expect(parseNumber('1,0,0', 'de-DE')).toBeNaN();
  });
});

describe('fmt.parseNumber', () => {
  it('reads with the formatter’s locale', () => {
    const de = createFormatter('metric', 'de-DE', 'de');
    const en = createFormatter('metric', 'en-US', 'en');
    expect(de.parseNumber('72,5')).toBe(72.5);
    expect(en.parseNumber('72.5')).toBe(72.5);
    expect(de.parseNumber('10.000')).toBe(10_000);
    expect(de.parseNumber('42.195', true)).toBe(42.195);
    expect(en.parseNumber(' 150 ')).toBe(150);
    expect(en.parseNumber('1e2')).toBeNaN();
  });
});

describe('heart rate zone limits', () => {
  it('are read with the locale, whole bpm, empty or malformed as null', () => {
    expect(parseBounds(['114', ' 133 ', '152,4', ''], 'de-DE')).toEqual([114, 133, 152, null]);
    expect(parseBounds(['114', '152.4', 'abc', '1e2', '-'], 'en-US')).toEqual([114, 152, null, null, null]);
  });
});
