import { afterAll, describe, expect, it } from 'vitest';
import { intradayTz, tzSpan } from '@/features/health/lib/tz';
import { createFormatter } from '@/lib/format';

const ts = (iso: string) => Date.parse(iso) / 1000;

describe('health offsets across a daylight-saving switch', () => {
  const saved = process.env.TZ;
  afterAll(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });

  // Vienna, 29 Mar 2026: 00:00 CET (+60) … 24:00 CEST (+120), clocks jump at 01:00 UTC; the server's day is 23 hours
  const spring = { tzMin: 60, dayStartTs: ts('2026-03-28T23:00:00Z'), dayEndTs: ts('2026-03-29T22:00:00Z') };
  // Vienna, 25 Oct 2026: 00:00 CEST (+120) … 24:00 CET (+60), clocks go back at 01:00 UTC; 25 hours
  const fall = { tzMin: 120, dayStartTs: ts('2026-10-24T22:00:00Z'), dayEndTs: ts('2026-10-25T23:00:00Z') };

  it('keeps one offset on a day without a switch', () => {
    process.env.TZ = 'Europe/Vienna';
    const tz = intradayTz({ tzMin: 60, dayStartTs: ts('2026-03-27T23:00:00Z'), dayEndTs: ts('2026-03-28T23:00:00Z') });
    expect([ts('2026-03-27T23:00:00Z'), ts('2026-03-28T12:00:00Z'), ts('2026-03-28T22:59:59Z')].map(tz)).toEqual([60, 60, 60]);
  });

  it('switches at the moment the clocks change, in the zone of the browser', () => {
    process.env.TZ = 'Europe/Vienna';
    const s = intradayTz(spring);
    expect(s(ts('2026-03-29T00:59:59Z'))).toBe(60);
    expect(s(ts('2026-03-29T01:00:00Z'))).toBe(120);
    expect(s(spring.dayEndTs)).toBe(120);
    const f = intradayTz(fall);
    expect(f(ts('2026-10-25T00:59:59Z'))).toBe(120);
    expect(f(ts('2026-10-25T01:00:00Z'))).toBe(60);

    // New York falls back at 02:00 EDT (06:00 UTC), an hour before 02:00 standard time
    process.env.TZ = 'America/New_York';
    const ny = intradayTz({ tzMin: -240, dayStartTs: ts('2026-11-01T04:00:00Z'), dayEndTs: ts('2026-11-02T05:00:00Z') });
    expect(ny(ts('2026-11-01T05:59:59Z'))).toBe(-240);
    expect(ny(ts('2026-11-01T06:00:00Z'))).toBe(-300);
  });

  it('assumes 02:00 standard time when the browser is in another zone', () => {
    process.env.TZ = 'Asia/Tokyo';
    const s = intradayTz(spring);
    expect(s(ts('2026-03-29T00:59:59Z'))).toBe(60);
    expect(s(ts('2026-03-29T01:00:00Z'))).toBe(120);
    const f = intradayTz(fall);
    expect(f(ts('2026-10-25T00:59:59Z'))).toBe(120);
    expect(f(ts('2026-10-25T01:00:00Z'))).toBe(60);
    // a night: in bed 23:23 CET, up 08:01 CEST
    const night = tzSpan(ts('2026-03-28T22:23:00Z'), 60, ts('2026-03-29T06:01:00Z'), 120);
    expect(night(ts('2026-03-28T23:30:00Z'))).toBe(60);
    expect(night(ts('2026-03-29T01:00:00Z'))).toBe(120);
    // no 02:00 inside the stretch (an afternoon flight): the start's offset up to the end
    const flight = tzSpan(ts('2026-06-01T12:00:00Z'), 120, ts('2026-06-01T15:00:00Z'), 60);
    expect(flight(ts('2026-06-01T14:59:59Z'))).toBe(120);
    expect(flight(ts('2026-06-01T15:00:00Z'))).toBe(60);
  });

  it('labels the hours of a 23-hour and a 25-hour day with the clock of that moment', () => {
    process.env.TZ = 'Europe/Vienna';
    const fmt = createFormatter('metric', 'de-DE', 'de');
    const hours = (d: typeof spring) => {
      const tz = intradayTz(d);
      const out: string[] = [];
      for (let t = d.dayStartTs; t < d.dayEndTs; t += 3600) out.push(fmt.time(t, tz(t)));
      return out;
    };
    const s = hours(spring);
    expect(s).toHaveLength(23);
    expect(s.slice(0, 4)).toEqual(['00:00', '01:00', '03:00', '04:00']);
    expect(s.at(-1)).toBe('23:00');
    const f = hours(fall);
    expect(f).toHaveLength(25);
    expect(f.slice(0, 5)).toEqual(['00:00', '01:00', '02:00', '02:00', '03:00']);
    expect(f.at(-1)).toBe('23:00');
  });
});
