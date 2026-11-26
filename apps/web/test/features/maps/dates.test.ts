/** Date hints of the route and segment pages (apps/web/src/features/maps/lib/dates.ts). */
import { describe, expect, it } from 'vitest';
import { dateHint, dateRange } from '@/features/maps/lib/dates';
import { createFormatter } from '@/lib/format';

const fmt = createFormatter('metric', 'en-GB', 'en');
const de = createFormatter('metric', 'de-DE', 'de');
/** unix seconds of noon UTC on a day */
const ts = (day: string) => Date.parse(`${day}T12:00:00Z`) / 1000;

describe('route and segment date hints', () => {
  it('names both years of a range that spans years (sample route 34: Feb 2025 – Oct 2026)', () => {
    expect(dateRange(fmt, ts('2025-02-04'), 60, ts('2026-10-27'), 60)).toBe('4 Feb 2025 – 27 Oct 2026');
    expect(dateRange(de, ts('2025-02-04'), 60, ts('2026-10-27'), 60)).toBe('4. Feb. 2025 – 27. Okt. 2026');
  });

  it('names the year once for a range within one year, and one day once', () => {
    expect(dateRange(fmt, ts('2026-02-04'), 60, ts('2026-10-27'), 60)).toBe('4 Feb – 27 Oct 2026');
    expect(dateRange(fmt, ts('2026-10-27') - 3600 * 4, 60, ts('2026-10-27'), 60)).toBe('27 Oct 2026');
  });

  it('uses the local day of each date (tz offset)', () => {
    // 23:30 UTC on 31 Dec 2025 is already 2026 at +01:00
    expect(dateRange(fmt, ts('2025-12-31') + 11.5 * 3600, 60, ts('2026-03-01'), 60)).toBe('1 Jan – 1 Mar 2026');
  });

  it('leaves the year out of single dates in the current year only', () => {
    expect(dateHint(fmt, ts('2026-10-27'), 60, '2026-11-26')).toBe('27 Oct');
    expect(dateHint(fmt, ts('2025-10-27'), 60, '2026-11-26')).toBe('27 Oct 2025');
  });
});
