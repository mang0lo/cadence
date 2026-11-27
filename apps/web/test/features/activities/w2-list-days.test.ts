import { describe, expect, it } from 'vitest';
import { listPageQuery } from '@/features/activities/api';
import { parseListParams } from '@/features/activities/lib/listParams';

/**
 * The activities page asks for its period as local days (each activity on the day of its own time zone). The API
 * refuses days that do not exist, so a hand-edited URL ('2026-02-30') must not turn the list into an error.
 */
const query = (qs: string, today = '2026-03-11') => listPageQuery(parseListParams(new URLSearchParams(qs)), 1, today);

describe('activities list request', () => {
  it('sends the period as local days instead of the browser zone’s unix seconds', () => {
    const q = query('range=custom&from=2026-02-01&to=2026-02-28&sport=run&page=2');
    expect(q).toMatchObject({ fromDay: '2026-02-01', toDay: '2026-02-28', sport: 'run', offset: 25 });
    expect(q.from).toBeUndefined();
    expect(q.to).toBeUndefined();
    expect(query('range=week')).toMatchObject({ fromDay: '2026-03-09', toDay: undefined });
    expect(query('')).toMatchObject({ fromDay: undefined, toDay: undefined });
  });

  it('leaves out days that do not exist, so that end of the period stays open', () => {
    expect(query('range=custom&from=2026-02-30&to=2026-03-31')).toMatchObject({ fromDay: undefined, toDay: '2026-03-31' });
    expect(query('range=custom&from=2026-02-01&to=2026-13-01')).toMatchObject({ fromDay: '2026-02-01', toDay: undefined });
    // a leap day only in leap years
    expect(query('range=custom&to=2026-02-29').toDay).toBeUndefined();
    expect(query('range=custom&to=2028-02-29').toDay).toBe('2028-02-29');
  });
});
