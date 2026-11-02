import { daysFromCivil } from '../lib/time';

/** A parsed Apple Health date: unix seconds (UTC) + the UTC offset in minutes written in the string. */
export interface ParsedDate {
  ts: number;
  tzMin: number;
}

const D0 = 48; // '0'

function digit(s: string, i: number): number {
  const c = s.charCodeAt(i) - D0;
  return c >= 0 && c <= 9 ? c : NaN;
}

function num2(s: string, i: number): number {
  return digit(s, i) * 10 + digit(s, i + 1);
}

/** Reusable out-parameter for the hot path. */
export const lastTz = { tzMin: 0 };

/**
 * Hot-path parser for `YYYY-MM-DD HH:MM:SS ±HHMM` (the format of every date attribute in export.xml).
 * Returns unix seconds and stores the offset in `lastTz.tzMin`; NaN when the string does not match
 * (callers then fall back to `parseAppleDate`).
 */
export function parseAppleDateFast(s: string): number {
  if (s.length < 25 || s.charCodeAt(4) !== 45 || s.charCodeAt(10) !== 32 || s.charCodeAt(19) !== 32)
    return NaN;
  const y = digit(s, 0) * 1000 + digit(s, 1) * 100 + num2(s, 2);
  const mo = num2(s, 5);
  const d = num2(s, 8);
  const h = num2(s, 11);
  const mi = num2(s, 14);
  const se = num2(s, 17);
  const sign = s.charCodeAt(20);
  const oh = num2(s, 21);
  const om = num2(s, 23);
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 24 && mi <= 59 && se <= 60 && oh <= 18 && om <= 59))
    return NaN;
  if (sign !== 43 && sign !== 45) return NaN;
  const tz = (sign === 45 ? -1 : 1) * (oh * 60 + om) || 0; // no -0 for "-0000"
  lastTz.tzMin = tz;
  return daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se - tz * 60;
}

/**
 * Parse an Apple Health date (`2024-05-01 07:30:12 +0200`). Tolerates ISO 8601 variants
 * (`2024-05-01T07:30:12+02:00`, `…Z`, no offset = UTC) through a slower fallback. Null when unparseable.
 */
export function parseAppleDate(s: string | null | undefined): ParsedDate | null {
  if (!s) return null;
  const ts = parseAppleDateFast(s);
  if (!Number.isNaN(ts)) return { ts, tzMin: lastTz.tzMin };
  return parseLooseDate(s);
}

const LOOSE_RE =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2}|[+-]\d{2})?$/i;

function parseLooseDate(input: string): ParsedDate | null {
  const s = input.trim();
  const m = LOOSE_RE.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const h = Number(m[4] ?? 0);
    const mi = Number(m[5] ?? 0);
    const se = Number(m[6] ?? 0);
    let tz = 0;
    const off = m[8];
    if (off && off.toUpperCase() !== 'Z') {
      const sign = off[0] === '-' ? -1 : 1;
      const digits = off.slice(1).replace(':', '');
      tz = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0));
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { ts: daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se - tz * 60, tzMin: tz };
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return { ts: Math.floor(t / 1000), tzMin: 0 };
}

/**
 * ISO 8601 timestamps as used in GPX (`2024-05-01T05:30:12Z`, optionally with fractions or an offset).
 * Returns unix seconds (may be fractional) or NaN.
 */
export function parseIsoTime(s: string): number {
  if (
    s.length >= 20 &&
    s.charCodeAt(4) === 45 &&
    s.charCodeAt(7) === 45 &&
    (s.charCodeAt(10) === 84 || s.charCodeAt(10) === 32) &&
    s.charCodeAt(13) === 58 &&
    s.charCodeAt(16) === 58
  ) {
    const y = digit(s, 0) * 1000 + digit(s, 1) * 100 + num2(s, 2);
    const base =
      daysFromCivil(y, num2(s, 5), num2(s, 8)) * 86400 + num2(s, 11) * 3600 + num2(s, 14) * 60 + num2(s, 17);
    let i = 19;
    let frac = 0;
    if (s.charCodeAt(i) === 46) {
      let scale = 0.1;
      i++;
      for (; i < s.length; i++) {
        const c = s.charCodeAt(i) - D0;
        if (c < 0 || c > 9) break;
        frac += c * scale;
        scale /= 10;
      }
    }
    const z = s.charCodeAt(i);
    if (i === s.length || z === 90 || z === 122) return base + frac;
    if (z === 43 || z === 45) {
      const oh = num2(s, i + 1);
      const om = s.charCodeAt(i + 3) === 58 ? num2(s, i + 4) : num2(s, i + 3);
      const off = (z === 45 ? -1 : 1) * (oh * 60 + (Number.isNaN(om) ? 0 : om));
      return base + frac - off * 60;
    }
  }
  const p = parseLooseDate(s);
  return p ? p.ts : NaN;
}

const pad = (n: number, w = 2) => String(Math.abs(Math.trunc(n))).padStart(w, '0');

/** Format as Apple does: `2024-05-01 07:30:12 +0200` (local wall clock for the given offset). */
export function formatAppleDate(ts: number, tzMin: number): string {
  const d = new Date((Math.floor(ts) + tzMin * 60) * 1000);
  const sign = tzMin < 0 ? '-' : '+';
  const a = Math.abs(tzMin);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${sign}${pad(Math.floor(a / 60))}${pad(a % 60)}`
  );
}

/** ISO 8601 UTC (`2024-05-01T05:30:12Z`), whole seconds. */
export function formatIsoUtc(ts: number): string {
  return new Date(Math.round(ts) * 1000).toISOString().replace('.000Z', 'Z');
}
