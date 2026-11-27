/**
 * t() (lib/i18n.tsx createT, the function I18nProvider hands out): lookup with fallbacks, plurals, interpolation, and
 * numbers written the way the locale writes them.
 */
import { describe, expect, it } from 'vitest';
import { createT, type Dictionary } from '@/lib/i18n';

const ns: Record<string, Dictionary> = {
  x: {
    en: {
      things: { one: '{count} thing', other: '{count} things' },
      plain: '{count} records',
      value: 'Value: {value}',
      range: '{from}–{to} of {total}',
      year: 'Since {year}',
      compare: '{year} vs {prev} ({previousYear})',
      named: 'Hello {name}',
      onlyEn: 'English only',
    },
    de: {
      things: { one: '{count} Ding', other: '{count} Dinge' },
      plain: '{count} Datensätze',
      value: 'Wert: {value}',
      range: '{from}–{to} von {total}',
      year: 'Seit {year}',
      compare: '{year} vs. {prev} ({previousYear})',
      named: 'Hallo {name}',
    },
  },
};

const en = createT('en', 'en-US', ns);
const de = createT('de', 'de-DE', ns);

describe('t()', () => {
  it('writes numbers the way the locale writes them', () => {
    expect(en('x.things', { count: 1234 })).toBe('1,234 things');
    expect(de('x.things', { count: 1234 })).toBe('1.234 Dinge');
    expect(de('x.plain', { count: 1234567 })).toBe('1.234.567 Datensätze');
    expect(en('x.range', { from: 1001, to: 1050, total: 12345 })).toBe('1,001–1,050 of 12,345');
    expect(de('x.value', { value: 1.5 })).toBe('Wert: 1,5');
    expect(en('x.value', { value: 1.5 })).toBe('Value: 1.5');
    expect(en('x.value', { value: -1234.5 })).toBe('Value: -1,234.5');
    expect(en('x.value', { value: -0 })).toBe('Value: 0');
    expect(en('x.value', { value: -0.0001 })).toBe('Value: 0');
  });

  it('leaves calendar years as they are', () => {
    expect(en('x.year', { year: 2026 })).toBe('Since 2026');
    expect(de('x.year', { year: 2026 })).toBe('Seit 2026');
    expect(de('x.compare', { year: 2026, prev: 2025, previousYear: 2025 })).toBe('2026 vs. 2025 (2025)');
  });

  it('keeps text that callers formatted already', () => {
    expect(de('x.value', { value: '1.234,5 km' })).toBe('Wert: 1.234,5 km');
    expect(de('x.range', { from: '1.001', to: '1.050', total: '12.345' })).toBe('1.001–1.050 von 12.345');
    expect(de('x.named', { name: 'Ana' })).toBe('Hallo Ana');
  });

  it('picks the plural form from the count, also from a count the caller formatted', () => {
    expect(en('x.things', { count: 1 })).toBe('1 thing');
    expect(en('x.things', { count: 0 })).toBe('0 things');
    expect(de('x.things', { count: 1 })).toBe('1 Ding');
    expect(de('x.things', { count: '1' })).toBe('1 Ding');
    // '1.000' is a thousand in German (Number('1.000') would be 1: "1.000 Ding")
    expect(de('x.things', { count: '1.000' })).toBe('1.000 Dinge');
    expect(en('x.things', { count: '1,000' })).toBe('1,000 things');
    expect(de('x.things', { count: '1,5' })).toBe('1,5 Dinge');
    expect(createT('de', 'de-CH', ns)('x.things', { count: '1’000' })).toBe('1’000 Dinge');
    expect(de('x.things')).toBe('{count} Dinge');
  });

  it('falls back to English, then to the key, and keeps unknown placeholders', () => {
    expect(de('x.onlyEn')).toBe('English only');
    expect(de('x.missing')).toBe('x.missing');
    expect(de('nope.key', { count: 2 })).toBe('nope.key');
    expect(en('x.named', { other: 1 })).toBe('Hello {name}');
  });
});
