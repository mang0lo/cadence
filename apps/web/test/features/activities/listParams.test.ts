/**
 * URL state of the activities list (apps/web/src/features/activities/lib/listParams.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SORT_OPTIONS,
  parseListParams,
  patchListParams,
  rangeBounds,
  rangeDays,
  sortOption,
  sortPatch,
  toListQuery,
} from '@/features/activities/lib/listParams';

const p = (s: string) => new URLSearchParams(s);

describe('list params: parsing and patching', () => {
  it('falls back to the defaults for missing or malformed values', () => {
    const s = parseListParams(p('range=nope&sort=bogus&size=7&page=-3&from=2026-1-1&order=up'));
    expect(s).toMatchObject({ range: 'all', sort: 'start', size: 25, page: 1, fromDay: '', order: 'desc', sports: [], gps: false });
    const t = parseListParams(p('sport=run,ride&range=custom&from=2026-07-01&to=2026-07-31&gps=1&sort=pace&order=asc&page=3&size=50'));
    expect(t).toMatchObject({ sports: ['run', 'ride'], range: 'custom', fromDay: '2026-07-01', toDay: '2026-07-31', gps: true });
    expect(t).toMatchObject({ sort: 'pace', order: 'asc', page: 3, size: 50 });
  });

  it('goes back to page 1 on every change except paging and removes empty values', () => {
    expect(patchListParams(p('q=run&page=4'), { gps: '1' }).toString()).toBe('q=run&gps=1');
    expect(patchListParams(p('q=run&page=4'), { page: '5' }).toString()).toBe('q=run&page=5');
    expect(patchListParams(p('q=run&gps=1'), { q: '', gps: null }).toString()).toBe('');
  });

  it('builds a later change on an earlier one (a pending search after a filter click)', () => {
    const afterChip = patchListParams(p(''), { gps: '1' });
    expect(patchListParams(afterChip, { q: 'run' }).toString()).toBe('gps=1&q=run');
  });
});

describe('list params: sort select', () => {
  it('offers both directions of every column, so a header sort is always shown correctly', () => {
    for (const sort of ['start', 'distance', 'time', 'pace', 'elevation', 'hr', 'effort'] as const)
      for (const order of ['asc', 'desc'] as const) expect(SORT_OPTIONS).toContain(sortOption(sort, order));
    expect(sortPatch('start-desc')).toEqual({ sort: null, order: null });
    expect(sortPatch('distance-asc')).toEqual({ sort: 'distance', order: 'asc' });
    expect(sortPatch('pace-desc')).toEqual({ sort: 'pace', order: null });
  });
});

describe('list params: periods', () => {
  const saved = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Europe/Vienna';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });

  it('gives the local days of every period', () => {
    const today = '2026-11-24'; // a Tuesday
    expect(rangeDays('week', '', '', 1, today)).toEqual({ fromDay: '2026-11-23' });
    expect(rangeDays('week', '', '', 0, today)).toEqual({ fromDay: '2026-11-22' });
    expect(rangeDays('month', '', '', 1, today)).toEqual({ fromDay: '2026-11-01' });
    expect(rangeDays('year', '', '', 1, today)).toEqual({ fromDay: '2026-01-01' });
    expect(rangeDays('d90', '', '', 1, today)).toEqual({ fromDay: '2026-08-27' });
    expect(rangeDays('custom', '2026-07-01', '', 1, today)).toEqual({ fromDay: '2026-07-01', toDay: undefined });
    expect(rangeDays('all', '2026-07-01', '2026-07-31', 1, today)).toEqual({});
  });

  it('starts every day at its own local midnight, also in the other half of the year', () => {
    // in November (CET) the summer days of July still start at 00:00 CEST (UTC+2)
    const b = rangeBounds(rangeDays('custom', '2026-07-01', '2026-07-31', 1, '2026-11-24'));
    expect(b.from).toBe(Date.UTC(2026, 5, 30, 22) / 1000);
    expect(b.to).toBe(Date.UTC(2026, 6, 31, 22) / 1000);
    expect(rangeBounds(rangeDays('d90', '', '', 1, '2026-11-24')).from).toBe(Date.UTC(2026, 7, 26, 22) / 1000);
    // across the change to winter time on 2026-10-25
    const oct = rangeBounds({ fromDay: '2026-10-24', toDay: '2026-10-25' });
    expect(oct.to! - oct.from!).toBe(49 * 3600);
  });

  it('turns a list state into the list request', () => {
    const q = toListQuery(parseListParams(p('sport=run&range=month&q=lake&gps=1&page=2&size=50')), 1, '2026-11-24');
    expect(q).toEqual({
      sport: 'run',
      from: Date.UTC(2026, 9, 31, 23) / 1000,
      to: undefined,
      q: 'lake',
      hasRoute: true,
      includeHidden: undefined,
      sort: 'start',
      order: 'desc',
      limit: 50,
      offset: 50,
    });
  });
});
