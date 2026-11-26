import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFormatter } from '@/lib/format';

const de = createFormatter('metric', 'de-DE', 'de');
const en = createFormatter('metric', 'en-US', 'en');

describe('fmt names and relative times', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reuses its Intl formatters instead of building one per call', () => {
    const now = Date.now() / 1000;
    // warm up (the cache is per locale, shared by every formatter)
    de.relative(now - 3 * 86_400);
    de.weekdayNames(1, 'short');
    de.monthNames('long');
    const rel = vi.spyOn(Intl, 'RelativeTimeFormat');
    const dt = vi.spyOn(Intl, 'DateTimeFormat');
    const feed = Array.from({ length: 40 }, (_, i) => de.relative(now - i * 3600 * 7));
    for (let i = 0; i < 20; i++) {
      de.weekdayNames(1, 'short');
      de.monthNames('long');
    }
    expect(rel).not.toHaveBeenCalled();
    expect(dt).not.toHaveBeenCalled();
    expect(feed[3]).toBe('vor 21 Stunden');
  });

  it('gives the same names and texts as before', () => {
    const now = Date.now() / 1000;
    expect(de.relative(now - 3 * 86_400)).toBe('vor 3 Tagen');
    expect(en.relative(now - 86_400)).toBe('yesterday');
    expect(en.relative(now + 2 * 3600)).toBe('in 2 hours');
    // what a new formatter per call gave
    const names = (locale: string, opts: Intl.DateTimeFormatOptions, dates: number[]) =>
      dates.map((d) => new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' }).format(new Date(d)));
    const monday = Array.from({ length: 7 }, (_, i) => Date.UTC(2024, 0, 8 + i));
    const sunday = Array.from({ length: 7 }, (_, i) => Date.UTC(2024, 0, 7 + i));
    const months = Array.from({ length: 12 }, (_, i) => Date.UTC(2024, i, 1));
    expect(de.weekdayNames(1, 'short')).toEqual(names('de-DE', { weekday: 'short' }, monday));
    expect(en.weekdayNames(0, 'narrow')).toEqual(names('en-US', { weekday: 'narrow' }, sunday));
    expect(de.weekdayNames(0, 'long')).toEqual(names('de-DE', { weekday: 'long' }, sunday));
    expect(de.monthNames('long')).toEqual(names('de-DE', { month: 'long' }, months));
    expect(en.monthNames('short')).toEqual(names('en-US', { month: 'short' }, months));
    expect(de.weekdayNames(1, 'long')[0]).toBe('Montag');
  });
});
