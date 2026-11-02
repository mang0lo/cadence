import { describe, expect, it } from 'vitest';
import {
  formatAppleDate,
  formatIsoUtc,
  parseAppleDate,
  parseAppleDateFast,
  parseIsoTime,
} from '../src/import/dates';
import { civilFromDays, dayString, daysFromCivil, localDay, parseDay } from '../src/lib/time';
import { isValidTimeZone, tzOffsetMinutes } from '../src/lib/tz';

describe('Apple date parsing', () => {
  it('parses the export format with positive and negative offsets', () => {
    expect(parseAppleDate('2024-05-01 07:30:12 +0200')).toEqual({
      ts: Date.UTC(2024, 4, 1, 5, 30, 12) / 1000,
      tzMin: 120,
    });
    expect(parseAppleDate('2023-12-31 23:59:59 -0500')).toEqual({
      ts: Date.UTC(2024, 0, 1, 4, 59, 59) / 1000,
      tzMin: -300,
    });
    expect(parseAppleDate('2020-02-29 12:00:00 +0530')).toEqual({
      ts: Date.UTC(2020, 1, 29, 6, 30, 0) / 1000,
      tzMin: 330,
    });
    expect(parseAppleDate('1970-01-01 00:00:00 +0000')).toEqual({ ts: 0, tzMin: 0 });
  });

  it('matches Date.parse for many random dates', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 5000; i++) {
      const ts = Math.floor(946684800 + rnd() * 1_000_000_000);
      const tz = Math.round((rnd() * 26 - 12) * 4) * 15 || 0;
      const s = formatAppleDate(ts, tz);
      const iso = `${s.slice(0, 10)}T${s.slice(11, 19)}${s.slice(20, 23)}:${s.slice(23, 25)}`;
      expect(parseAppleDateFast(s)).toBe(Date.parse(iso) / 1000);
      expect(parseAppleDate(s)).toEqual({ ts, tzMin: tz });
    }
  });

  it('falls back to ISO variants and rejects garbage', () => {
    expect(parseAppleDate('2024-05-01T07:30:12+02:00')).toEqual({
      ts: Date.UTC(2024, 4, 1, 5, 30, 12) / 1000,
      tzMin: 120,
    });
    expect(parseAppleDate('2024-05-01T05:30:12Z')?.ts).toBe(Date.UTC(2024, 4, 1, 5, 30, 12) / 1000);
    expect(parseAppleDate('2024-05-01')?.ts).toBe(Date.UTC(2024, 4, 1) / 1000);
    expect(Number.isNaN(parseAppleDateFast('2024-13-01 07:30:12 +0200'))).toBe(true);
    expect(parseAppleDate('not a date')).toBeNull();
    expect(parseAppleDate('')).toBeNull();
    expect(parseAppleDate(undefined)).toBeNull();
  });

  it('parses GPX ISO times incl. fractions and offsets', () => {
    const base = Date.UTC(2024, 4, 1, 5, 30, 12) / 1000;
    expect(parseIsoTime('2024-05-01T05:30:12Z')).toBe(base);
    expect(parseIsoTime('2024-05-01T05:30:12.250Z')).toBeCloseTo(base + 0.25, 6);
    expect(parseIsoTime('2024-05-01T07:30:12+02:00')).toBe(base);
    expect(parseIsoTime('2024-05-01T05:30:12')).toBe(base);
    expect(formatIsoUtc(base)).toBe('2024-05-01T05:30:12Z');
  });
});

describe('calendar helpers', () => {
  it('round-trips civil dates', () => {
    for (let d = -1000; d < 30000; d += 37) {
      const [y, m, dd] = civilFromDays(d);
      expect(daysFromCivil(y, m, dd)).toBe(d);
    }
    expect(dayString(daysFromCivil(2024, 2, 29))).toBe('2024-02-29');
    expect(parseDay('2024-02-29')).toBe(daysFromCivil(2024, 2, 29));
    expect(parseDay('2024-2-29')).toBeNull();
  });

  it('computes local days with the offset', () => {
    const ts = Date.UTC(2024, 4, 1, 23, 30) / 1000;
    expect(localDay(ts, 0)).toBe('2024-05-01');
    expect(localDay(ts, 120)).toBe('2024-05-02');
    expect(localDay(ts, -300)).toBe('2024-05-01');
  });
});

describe('time zones (HKTimeZone)', () => {
  it('resolves IANA offsets incl. DST', () => {
    expect(isValidTimeZone('Europe/Vienna')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(tzOffsetMinutes('Europe/Vienna', Date.UTC(2024, 0, 15) / 1000)).toBe(60);
    expect(tzOffsetMinutes('Europe/Vienna', Date.UTC(2024, 6, 15) / 1000)).toBe(120);
    expect(tzOffsetMinutes('America/New_York', Date.UTC(2024, 6, 15, 12) / 1000)).toBe(-240);
    expect(tzOffsetMinutes('Asia/Kolkata', Date.UTC(2024, 6, 15) / 1000)).toBe(330);
    expect(tzOffsetMinutes('Nowhere/Land', 0)).toBeNull();
  });
});
