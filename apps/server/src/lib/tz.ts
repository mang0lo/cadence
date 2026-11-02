/**
 * IANA time zone offsets via Intl (no tz database bundled). Used for workouts/records that carry an
 * `HKTimeZone` metadata entry: Apple writes every date in the export in the zone of the exporting phone,
 * so the original local time of a workout recorded abroad is only recoverable from HKTimeZone.
 */

const formatters = new Map<string, Intl.DateTimeFormat | null>();
const offsetCache = new Map<string, number>();

function formatter(zone: string): Intl.DateTimeFormat | null {
  let f = formatters.get(zone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      });
    } catch {
      f = null;
    }
    formatters.set(zone, f);
  }
  return f;
}

export function isValidTimeZone(zone: string | null | undefined): zone is string {
  return !!zone && zone.length < 64 && formatter(zone) !== null;
}

/** UTC offset in minutes of `zone` at unix time `ts`, or null for an unknown zone. */
export function tzOffsetMinutes(zone: string, ts: number): number | null {
  const f = formatter(zone);
  if (!f) return null;
  // Offsets only change on quarter-hour boundaries, so cache per 15 minutes.
  const key = `${zone}|${Math.floor(ts / 900)}`;
  const hit = offsetCache.get(key);
  if (hit !== undefined) return hit;
  const parts = f.formatToParts(new Date(Math.floor(ts) * 1000));
  let y = 0;
  let mo = 0;
  let d = 0;
  let h = 0;
  let mi = 0;
  let s = 0;
  for (const p of parts) {
    switch (p.type) {
      case 'year':
        y = Number(p.value);
        break;
      case 'month':
        mo = Number(p.value);
        break;
      case 'day':
        d = Number(p.value);
        break;
      case 'hour':
        h = Number(p.value) % 24;
        break;
      case 'minute':
        mi = Number(p.value);
        break;
      case 'second':
        s = Number(p.value);
        break;
    }
  }
  const local = Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
  const off = Math.round((local - Math.floor(ts)) / 60);
  if (offsetCache.size > 50_000) offsetCache.clear();
  offsetCache.set(key, off);
  return off;
}
