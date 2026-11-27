import { z } from 'zod';
import { parseDay } from './time';

/**
 * A local day 'YYYY-MM-DD' that exists in the calendar. Use it for every day a route takes (fromDay, toDay,
 * sinceDay …): '2026-02-30' or '2026-13-01' are a 400 (invalid_request), not an empty or failing answer.
 */
export const zDay = z.string().refine((d) => parseDay(d) !== null, 'expected a calendar day YYYY-MM-DD');
