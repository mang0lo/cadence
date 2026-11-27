import { afterEach, describe, expect, it, vi } from 'vitest';
import { clock as clockOf, createFormatter, paceUnitM, speedChartValue, speedFormat } from '@/lib/format';

const de = createFormatter('metric', 'de-DE', 'de');
const en = createFormatter('metric', 'en-US', 'en');
const us = createFormatter('imperial', 'en-US', 'en');

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

describe('numbers that round to zero', () => {
  it('have no minus sign ("-0 °C", "-0 m", "-0,0")', () => {
    // start temperatures of sample workouts 5, 333 and 352
    expect(de.temperature(-0.167)).toBe('0 °C');
    expect(en.temperature(-0.389)).toBe('0 °C');
    expect(de.elevation(-0.3)).toBe('0 m');
    expect(de.num(-0.04, 1)).toBe('0,0');
    expect(de.int(-0.4)).toBe('0');
    expect(de.num(-0)).toBe('0');
    expect(de.weight(-0.01)).toBe('0,0 kg');
    expect(de.pct(-0.001)).toBe('0\u00a0%');
    expect(en.compact(-0.04)).toBe('0');
    expect(clockOf(-0.3)).toBe('0:00');
  });

  it('keep their sign when they do not', () => {
    expect(de.temperature(-0.5)).toBe('-1 °C');
    expect(de.num(-0.05, 1)).toBe('-0,1');
    expect(de.pct(-0.006)).toBe('-1\u00a0%');
    expect(clockOf(-0.6)).toBe('−0:01');
    expect(de.signed(-0.04, 1)).toBe('±0,0');
  });
});

describe('speed and pace on charts', () => {
  it('converts a speed into the number fmt.pace shows: per km / mi, per 100 m / 100 yd for swims, km/h / mph', () => {
    expect(speedChartValue(4, 'run', 'metric')).toBeCloseTo(250, 9);
    expect(speedChartValue(1, 'swim', 'imperial')).toBeCloseTo(91.44, 9);
    expect(speedChartValue(10, 'ride', 'metric')).toBeCloseTo(36, 9);
    expect(speedChartValue(10, 'ride', 'imperial')).toBeCloseTo(36 / 1.609344, 9);
    expect(paceUnitM('swim', 'metric')).toBe(100);
    expect(paceUnitM('row', 'imperial')).toBe(1609.344);
    for (const [sport, mps] of [['run', 3.3], ['swim', 1.2], ['hike', 1.1]] as const) {
      expect(clockOf(speedFormat(en, sport).toChart(mps)), sport).toBe(en.paceParts(mps, sport).value);
      expect(clockOf(speedFormat(us, sport).toChart(mps)), sport).toBe(us.paceParts(mps, sport).value);
    }
  });

  it('gives signed differences in the unit of the sport', () => {
    // 5:00 /km → 4:50 /km is 10 s per km faster; 35 → 36 km/h is 1 km/h faster
    expect(speedFormat(en, 'run').delta(1000 / 300, 1000 / 290)).toBe('−0:10 /km');
    expect(speedFormat(en, 'swim').delta(1, 1)).toBe('±0:00 /100m');
    expect(speedFormat(en, 'ride').delta(35 / 3.6, 10)).toBe('+1.0 km/h');
    expect(speedFormat(de, 'ride').delta(10, 10.001)).toBe('±0,0 km/h');
    expect(speedFormat(us, 'ride').format(10)).toBe('22.4 mph');
    expect(speedFormat(us, 'run').unit).toBe('/mi');
  });
});
