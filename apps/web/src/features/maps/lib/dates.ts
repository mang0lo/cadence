import type { Formatter } from '@/lib/format';
import { dayKey, todayKey } from '@/lib/time';

/** A date in its own local time: without the year when it is in the current year ("4 Feb"), with it otherwise. */
export function dateHint(fmt: Formatter, ts: number, tzMin: number, today = todayKey()): string {
  return fmt.date(ts, tzMin, dayKey(ts, tzMin).slice(0, 4) === today.slice(0, 4) ? 'dayShort' : 'day');
}

/** "4 Feb – 27 Oct 2026", "4 Feb 2025 – 27 Oct 2026" (a range across years names both years), or one day. */
export function dateRange(fmt: Formatter, fromTs: number, fromTz: number, toTs: number, toTz: number): string {
  const from = dayKey(fromTs, fromTz);
  const to = dayKey(toTs, toTz);
  if (from === to) return fmt.date(toTs, toTz, 'day');
  return `${fmt.date(fromTs, fromTz, from.slice(0, 4) === to.slice(0, 4) ? 'dayShort' : 'day')} – ${fmt.date(toTs, toTz, 'day')}`;
}
