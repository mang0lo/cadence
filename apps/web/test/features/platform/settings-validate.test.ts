import { describe, expect, it } from 'vitest';
import {
  birthDateCommit,
  coordsText,
  isPlausibleBirthDate,
  parseBounds,
  zoneBoundsProblem,
  zonesBounds,
} from '@/features/platform/settings/validate';

const TODAY = '2026-11-25';

describe('birth date', () => {
  it('accepts real days from 1900 to today', () => {
    expect(isPlausibleBirthDate('1987-04-12', TODAY)).toBe(true);
    expect(isPlausibleBirthDate('1988-02-29', TODAY)).toBe(true);
    expect(isPlausibleBirthDate('1900-01-01', TODAY)).toBe(true);
    expect(isPlausibleBirthDate(TODAY, TODAY)).toBe(true);
  });

  it('rejects the years Chrome produces while a year is typed, impossible days and the future', () => {
    // typing 1987 into the year segment yields 0001, 0019, 0198 before 1987
    for (const v of ['0001-04-12', '0019-04-12', '0198-04-12', '0007-04-12']) expect(isPlausibleBirthDate(v, TODAY)).toBe(false);
    expect(isPlausibleBirthDate('1987-02-30', TODAY)).toBe(false);
    expect(isPlausibleBirthDate('1987-13-01', TODAY)).toBe(false);
    expect(isPlausibleBirthDate('2026-11-26', TODAY)).toBe(false);
    expect(isPlausibleBirthDate('1899-12-31', TODAY)).toBe(false);
    expect(isPlausibleBirthDate('87-04-12', TODAY)).toBe(false);
  });

  it('saves a new plausible date only when the field is left', () => {
    const input = (value: string, badInput = false) => ({ value, badInput });
    expect(birthDateCommit(input('1987-04-12'), null, '1988-04-12', TODAY)).toEqual({ save: '1987-04-12' });
    // nothing changed: no request, the export value does not become an override
    expect(birthDateCommit(input('1988-04-12'), null, '1988-04-12', TODAY)).toBeNull();
    expect(birthDateCommit(input('1987-04-12'), '1987-04-12', '1987-04-12', TODAY)).toBeNull();
    // half typed (Chrome reports '' and badInput) or a garbage year: nothing is saved
    expect(birthDateCommit(input('', true), '1987-04-12', '1987-04-12', TODAY)).toBeNull();
    expect(birthDateCommit(input('0198-04-12'), null, '1988-04-12', TODAY)).toBeNull();
  });

  it('goes back to the Apple Health value when the field is cleared', () => {
    expect(birthDateCommit({ value: '', badInput: false }, '1987-04-12', '1987-04-12', TODAY)).toEqual({ save: null });
    expect(birthDateCommit({ value: '', badInput: false }, null, '1988-04-12', TODAY)).toBeNull();
  });
});

describe('custom heart rate zones', () => {
  it('reads the four fields', () => {
    expect(parseBounds(['114', ' 133 ', '152.4', ''])).toEqual([114, 133, 152, null]);
    expect(parseBounds(['abc', '1e2', '-', '170'])).toEqual([null, 100, null, 170]);
  });

  it('needs four ascending limits between 40 and 240', () => {
    expect(zoneBoundsProblem([114, 133, 152, 171])).toBeNull();
    // the typo of the finding: Z3 below Z2 would be saved and silently ignored by the server
    expect(zoneBoundsProblem([114, 133, 130, 171])).toBe('order');
    expect(zoneBoundsProblem([114, 133, 133, 171])).toBe('order');
    expect(zoneBoundsProblem([114, 133, null, 171])).toBe('range');
    expect(zoneBoundsProblem([30, 133, 152, 171])).toBe('range');
    expect(zoneBoundsProblem([114, 133, 152, 250])).toBe('range');
  });
});

describe('privacy zones', () => {
  it('frames the zones with their radius', () => {
    expect(zonesBounds([])).toBeNull();
    const [w, s, e, n] = zonesBounds([
      { lat: 48.2, lon: 16.37, radiusM: 1113.2 },
      { lat: 40.7128, lon: -74.006, radiusM: 300 },
    ])!;
    expect(s).toBeCloseTo(40.7128 - 300 / 111_320, 6);
    expect(n).toBeCloseTo(48.2 + 0.01, 6);
    expect(w).toBeLessThan(-74.006);
    expect(e).toBeGreaterThan(16.37 + 0.01); // a degree of longitude is shorter than one of latitude at 48°
  });

  it('writes coordinates without mixing up the decimal comma and the separator', () => {
    const en = (v: number, d: number) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
    const de = (v: number, d: number) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
    expect(coordsText(en, 48.20821, 16.37382)).toBe('48.2082, 16.3738');
    expect(coordsText(de, 48.20821, 16.37382)).toBe('48,2082; 16,3738');
    expect(coordsText(de, -33.86785, 151.20732)).toBe('-33,8679; 151,2073');
  });
});
