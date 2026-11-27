/**
 * Year-aware dates of the formatter (apps/web/src/lib/format.ts: dayHint, dateHint, dayRange, dateRange), used by the
 * route and segment pages, the progress ranges and the consistency streaks; and the 'timeSeconds' / 'monthYear' styles.
 */
import { describe, expect, it } from 'vitest';
import { createFormatter } from '@/lib/format';

const fmt = createFormatter('metric', 'en-GB', 'en');
const de = createFormatter('metric', 'de-DE', 'de');
/** unix seconds of noon UTC on a day */
const ts = (day: string) => Date.parse(`${day}T12:00:00Z`) / 1000;

describe('year-aware dates', () => {
  it('names both years of a range that spans years (sample route 34: Feb 2025 – Oct 2026)', () => {
    expect(fmt.dateRange(ts('2025-02-04'), 60, ts('2026-10-27'), 60)).toBe('4 Feb 2025 – 27 Oct 2026');
    expect(de.dateRange(ts('2025-02-04'), 60, ts('2026-10-27'), 60)).toBe('4. Feb. 2025 – 27. Okt. 2026');
    expect(fmt.dayRange('2025-12-29', '2026-01-04')).toBe('29 Dec 2025 – 4 Jan 2026');
  });

  it('names the year once for a range within one year, and one day once', () => {
    expect(fmt.dateRange(ts('2026-02-04'), 60, ts('2026-10-27'), 60)).toBe('4 Feb – 27 Oct 2026');
    expect(fmt.dateRange(ts('2026-10-27') - 3600 * 4, 60, ts('2026-10-27'), 60)).toBe('27 Oct 2026');
    expect(fmt.dayRange('2026-03-03', '2026-03-23')).toBe('3 Mar – 23 Mar 2026');
    expect(de.dayRange('2026-03-03', '2026-03-03')).toBe('3. März 2026');
  });

  it('uses the local day of each date (tz offset)', () => {
    // 23:30 UTC on 31 Dec 2025 is already 2026 at +01:00
    expect(fmt.dateRange(ts('2025-12-31') + 11.5 * 3600, 60, ts('2026-03-01'), 60)).toBe('1 Jan – 1 Mar 2026');
    expect(fmt.dateHint(ts('2025-12-31') + 11.5 * 3600, 60, '2026-11-26')).toBe('1 Jan');
  });

  it('leaves the year out of single dates in the current year only', () => {
    expect(fmt.dateHint(ts('2026-10-27'), 60, '2026-11-26')).toBe('27 Oct');
    expect(fmt.dateHint(ts('2025-10-27'), 60, '2026-11-26')).toBe('27 Oct 2025');
    expect(de.dayHint('2025-10-27', '2026-11-26')).toBe('27. Okt. 2025');
    expect(de.dayHint('2026-10-27', '2026-11-26')).toBe('27. Okt.');
  });
});

describe('date styles', () => {
  it('shows times with seconds in the local time of a sample', () => {
    // 12:03:27 UTC at +02:00
    const t = Date.parse('2026-06-01T12:03:27Z') / 1000;
    expect(de.date(t, 120, 'timeSeconds')).toBe('14:03:27');
    expect(createFormatter('metric', 'en-US', 'en').date(t, 120, 'timeSeconds')).toBe('02:03:27 PM');
  });

  it('names a month with its full year (the short year reads like a day)', () => {
    expect(createFormatter('metric', 'en-US', 'en').day('2026-01-31', 'monthYear')).toBe('Jan 2026');
    expect(de.day('2026-03-01', 'monthYear')).toBe('März 2026');
  });
});
