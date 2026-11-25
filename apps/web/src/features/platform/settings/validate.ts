import type { PrivacyZone } from '@cadence/shared';

/** Pure checks of the settings form: what may be saved, and how zones are framed and written. */

/** A real calendar day 'YYYY-MM-DD' from 1900 up to `today`: anything else is a typo (e.g. a half-typed year). */
export function isPlausibleBirthDate(value: string, today: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return false;
  return y >= 1900 && value <= today;
}

/**
 * What to save when the birth date field is left: `{ save }` (null = the value from Apple Health again), or null to
 * save nothing — a partly typed date (`badInput`), an implausible one, or no change.
 */
export function birthDateCommit(
  input: { value: string; badInput: boolean },
  override: string | null,
  shown: string | null,
  today: string,
): { save: string | null } | null {
  if (input.badInput) return null;
  if (input.value === '') return override !== null ? { save: null } : null;
  if (input.value === (override ?? shown)) return null;
  return isPlausibleBirthDate(input.value, today) ? { save: input.value } : null;
}

/** The four zone limits as typed: whole numbers, null for an empty or unreadable field. */
export const parseBounds = (texts: string[]): (number | null)[] =>
  texts.map((s) => (s.trim() === '' || !Number.isFinite(Number(s)) ? null : Math.round(Number(s))));

export type ZoneBoundsProblem = 'range' | 'order';

/**
 * Upper limits of Z1..Z4 must be 40–240 bpm and each higher than the one before: the server ignores limits that do
 * not ascend and silently uses % of max HR instead.
 */
export function zoneBoundsProblem(bounds: (number | null)[]): ZoneBoundsProblem | null {
  if (bounds.some((b) => b === null || b < 40 || b > 240)) return 'range';
  if (bounds.some((b, i) => i > 0 && b! <= bounds[i - 1]!)) return 'order';
  return null;
}

const M_PER_DEG = 111_320;

/** [minLon, minLat, maxLon, maxLat] around the zones with their radius, null without zones. */
export function zonesBounds(zones: PrivacyZone[]): [number, number, number, number] | null {
  if (!zones.length) return null;
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const z of zones) {
    const dLat = z.radiusM / M_PER_DEG;
    const dLon = z.radiusM / (M_PER_DEG * Math.max(0.01, Math.cos((z.lat * Math.PI) / 180)));
    b[0] = Math.min(b[0], z.lon - dLon);
    b[1] = Math.min(b[1], z.lat - dLat);
    b[2] = Math.max(b[2], z.lon + dLon);
    b[3] = Math.max(b[3], z.lat + dLat);
  }
  return b;
}

/** "48.2082, 16.3738" — or "48,2082; 16,3738" where the decimal separator is a comma. */
export function coordsText(num: (v: number, digits: number) => string, lat: number, lon: number): string {
  const a = num(lat, 4);
  const b = num(lon, 4);
  return `${a}${a.includes(',') || b.includes(',') ? ';' : ','} ${b}`;
}
