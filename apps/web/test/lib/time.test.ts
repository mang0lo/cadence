import { describe, expect, it } from 'vitest';
import { addDays, dayKey, dayStartTs, diffDays, eachDay, periodKey, startOfWeek, weekday } from '@/lib/time';

describe('lib/time', () => {
  it('reads the local day of a timestamp from its own offset', () => {
    // 2024-03-30 23:30 UTC is already the 31st in Vienna (UTC+1) and still the 30th in New York (UTC-4)
    const ts = Date.UTC(2024, 2, 30, 23, 30) / 1000;
    expect(dayKey(ts, 60)).toBe('2024-03-31');
    expect(dayKey(ts, -240)).toBe('2024-03-30');
  });

  it('adds days across month, year and DST boundaries', () => {
    expect(addDays('2024-03-30', 2)).toBe('2024-04-01'); // DST starts in Europe on 2024-03-31
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(diffDays('2024-03-30', '2024-04-02')).toBe(3);
  });

  it('starts weeks on Monday or Sunday', () => {
    expect(weekday('2024-05-01')).toBe(3); // a Wednesday
    expect(startOfWeek('2024-05-01', 1)).toBe('2024-04-29');
    expect(startOfWeek('2024-05-01', 0)).toBe('2024-04-28');
    expect(startOfWeek('2024-04-28', 1)).toBe('2024-04-22'); // Sunday belongs to the week before
    expect(startOfWeek('2024-04-28', 0)).toBe('2024-04-28');
  });

  it('lists days inclusively and buckets them into periods', () => {
    expect(eachDay('2024-02-28', '2024-03-01')).toEqual(['2024-02-28', '2024-02-29', '2024-03-01']);
    expect(eachDay('2024-03-02', '2024-03-01')).toEqual([]);
    expect(periodKey('2024-05-01', 'week', 1)).toBe('2024-04-29');
    expect(periodKey('2024-05-01', 'month')).toBe('2024-05');
    expect(periodKey('2024-05-01', 'year')).toBe('2024');
  });

  it('gives local midnight for a day at an offset', () => {
    expect(dayStartTs('2024-05-01', 120)).toBe(Date.UTC(2024, 3, 30, 22, 0) / 1000);
    expect(dayStartTs('2024-05-01', 0)).toBe(Date.UTC(2024, 4, 1) / 1000);
  });
});
