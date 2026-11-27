/**
 * URL state of the activities list (pure): filters, sorting and paging live in the query string (shareable, back
 * button friendly). Periods are local calendar days; the API takes them as unix seconds (see rangeBounds).
 */
import type { ActivityListQuery, ActivitySort } from '@cadence/shared';
import { addDays, dayStartTs, startOfMonth, startOfWeek, startOfYear } from '@/lib/time';
import { patchParams, type ParamsPatch } from '@/lib/urlParams';

export const RANGES = ['all', 'week', 'month', 'year', 'd30', 'd90', 'm12', 'custom'] as const;
export type Range = (typeof RANGES)[number];
export const SORTS: ActivitySort[] = ['start', 'distance', 'time', 'pace', 'elevation', 'hr', 'effort'];
export const SIZES = ['25', '50', '100'] as const;
/** Sort choices of the card layout (narrow screens have no clickable column headers): every column both ways. */
export const SORT_OPTIONS = SORTS.flatMap((s) => [`${s}-desc`, `${s}-asc`] as const);
export type SortOption = (typeof SORT_OPTIONS)[number];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ListState {
  sports: string[];
  range: Range;
  fromDay: string;
  toDay: string;
  q: string;
  gps: boolean;
  hidden: boolean;
  sort: ActivitySort;
  order: 'asc' | 'desc';
  page: number;
  size: number;
}

/** The list state of a query string; unknown or malformed values fall back to the defaults. */
export function parseListParams(params: URLSearchParams): ListState {
  const get = (k: string) => params.get(k) ?? '';
  const range = (RANGES as readonly string[]).includes(get('range')) ? (get('range') as Range) : 'all';
  const sort = (SORTS as string[]).includes(get('sort')) ? (get('sort') as ActivitySort) : 'start';
  const size = (SIZES as readonly string[]).includes(get('size')) ? Number(get('size')) : 25;
  return {
    sports: get('sport') ? get('sport').split(',').filter(Boolean) : [],
    range,
    fromDay: DAY_RE.test(get('from')) ? get('from') : '',
    toDay: DAY_RE.test(get('to')) ? get('to') : '',
    q: get('q'),
    gps: get('gps') === '1',
    hidden: get('hidden') === '1',
    sort,
    order: get('order') === 'asc' ? 'asc' : 'desc',
    page: Math.max(1, Number.parseInt(get('page'), 10) || 1),
    size,
  };
}

/** A copy of `params` with `patch` applied (null / '' removes a key); every change except paging goes back to page 1. */
export function patchListParams(params: URLSearchParams, patch: ParamsPatch): URLSearchParams {
  const next = patchParams(params, patch);
  if (!('page' in patch)) next.delete('page');
  return next;
}

/** The value of the sort select for a sort column and direction … */
export const sortOption = (sort: ActivitySort, order: 'asc' | 'desc'): SortOption => `${sort}-${order}`;

/** … and the URL patch of a chosen one (the defaults, newest first, leave the URL clean). */
export function sortPatch(option: string): Record<string, string | null> {
  const [sort, order] = option.split('-') as [ActivitySort, 'asc' | 'desc'];
  return { sort: sort === 'start' ? null : sort, order: order === 'asc' ? 'asc' : null };
}

/** First and last local day (inclusive) of a period; open ends are omitted. `today` is the browser's day key. */
export function rangeDays(
  range: Range,
  fromDay: string,
  toDay: string,
  weekStart: 0 | 1,
  today: string,
): { fromDay?: string; toDay?: string } {
  switch (range) {
    case 'week':
      return { fromDay: startOfWeek(today, weekStart) };
    case 'month':
      return { fromDay: startOfMonth(today) };
    case 'year':
      return { fromDay: startOfYear(today) };
    case 'd30':
      return { fromDay: addDays(today, -29) };
    case 'd90':
      return { fromDay: addDays(today, -89) };
    case 'm12':
      return { fromDay: addDays(today, -364) };
    case 'custom':
      return { fromDay: fromDay || undefined, toDay: toDay || undefined };
    default:
      return {};
  }
}

/**
 * A period as the API's unix-second bounds [from, to): local midnight in the browser's time zone with each day's own
 * offset (a summer day keeps summer time while today is in winter time).
 */
export function rangeBounds(days: { fromDay?: string; toDay?: string }): { from?: number; to?: number } {
  return {
    from: days.fromDay ? dayStartTs(days.fromDay) : undefined,
    to: days.toDay ? dayStartTs(addDays(days.toDay, 1)) : undefined,
  };
}

/** The list request of a list state (page `s.page` of `s.size`). */
export function toListQuery(s: ListState, weekStart: 0 | 1, today: string): ActivityListQuery {
  const b = rangeBounds(rangeDays(s.range, s.fromDay, s.toDay, weekStart, today));
  return {
    sport: s.sports.join(',') || undefined,
    from: b.from,
    to: b.to,
    q: s.q || undefined,
    hasRoute: s.gps ? true : undefined,
    includeHidden: s.hidden || undefined,
    sort: s.sort,
    order: s.order,
    limit: s.size,
    offset: (s.page - 1) * s.size,
  };
}
