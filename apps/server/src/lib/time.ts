/**
 * Calendar helpers. All functions work on unix seconds + a UTC offset in minutes (`tzMin`),
 * the convention used everywhere in Cadence (see docs/ARCHITECTURE.md).
 */

/** Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm). */
export function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of daysFromCivil. */
export function civilFromDays(z: number): [y: number, m: number, d: number] {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return [y + (m <= 2 ? 1 : 0), m, d];
}

const pad2 = (n: number) => (n < 10 ? '0' : '') + n;

/** 'YYYY-MM-DD' for a day number (days since epoch). */
export function dayString(epochDay: number): string {
  const [y, m, d] = civilFromDays(epochDay);
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/** Local epoch day of a timestamp. */
export function epochDay(ts: number, tzMin: number): number {
  return Math.floor((ts + tzMin * 60) / 86400);
}

/** Local calendar day 'YYYY-MM-DD' of a timestamp. */
export function localDay(ts: number, tzMin: number): string {
  return dayString(epochDay(ts, tzMin));
}

/** Day number of a 'YYYY-MM-DD' string, or null when malformed. */
export function parseDay(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return daysFromCivil(Number(m[1]), mo, d);
}

/** Shift a 'YYYY-MM-DD' string by n days. */
export function addDays(day: string, n: number): string {
  const d = parseDay(day);
  if (d === null) throw new Error(`Invalid day ${day}`);
  return dayString(d + n);
}

/** Today's local day for a given offset (default: the server's current offset). */
export function today(tzMin = -new Date().getTimezoneOffset()): string {
  return localDay(Math.floor(Date.now() / 1000), tzMin);
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);
