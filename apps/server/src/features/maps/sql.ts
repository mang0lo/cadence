/** SQL fragments the maps queries share (one definition each). */

/** Visible workouts – not hidden and no duplicate of another one – are the ones analytics count. */
export function visible(alias = 'w'): string {
  const p = alias ? `${alias}.` : '';
  return `${p}hidden = 0 AND ${p}duplicate_of IS NULL`;
}

/**
 * Time of an activity on a route: moving time, falling back to the recorded duration (Apple's active time) when no
 * GPS speed was available.
 */
export const ROUTE_TIME = 'COALESCE(NULLIF(w.moving_s, 0), w.duration_s)';

/**
 * Right-hand side of `x IN …` for a list bound as ONE parameter, `idList(values)`: no limit on the number of values
 * and one cached statement for lists of any length.
 */
export const IN_LIST = '(SELECT value FROM json_each(?))';
export const idList = (values: readonly (number | string)[]): string => JSON.stringify(values);

/** A comma separated query parameter ('run,ride') as its trimmed, non-empty items. */
export function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
