import type { ProgressBucket } from '@cadence/shared';
import { addDays, dayKey, diffDays } from '@/lib/time';

/** Period presets of the progress filters. */
export type PeriodPreset = '3m' | '6m' | '12m' | 'ytd' | 'all';
export const PERIOD_PRESETS: PeriodPreset[] = ['3m', '6m', '12m', 'ytd', 'all'];

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Same day of month `months` earlier/later (clamped to the month length). */
export function shiftMonths(day: string, months: number): string {
  let y = Number(day.slice(0, 4));
  let m = Number(day.slice(5, 7)) + months;
  y += Math.floor((m - 1) / 12);
  m = ((((m - 1) % 12) + 12) % 12) + 1;
  const d = Math.min(Number(day.slice(8, 10)), lastDay(y, m));
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function isPeriodPreset(v: string | null): v is PeriodPreset {
  return !!v && (PERIOD_PRESETS as string[]).includes(v);
}

/** Day range of a preset ending today (`firstDay` = first activity, used by 'all'). */
export function presetRange(preset: PeriodPreset, today: string, firstDay: string | null): { fromDay: string; toDay: string } {
  switch (preset) {
    case '3m':
      return { fromDay: addDays(shiftMonths(today, -3), 1), toDay: today };
    case '6m':
      return { fromDay: addDays(shiftMonths(today, -6), 1), toDay: today };
    case '12m':
      return { fromDay: addDays(shiftMonths(today, -12), 1), toDay: today };
    case 'ytd':
      return { fromDay: `${today.slice(0, 4)}-01-01`, toDay: today };
    case 'all': {
      const from = firstDay && firstDay < today ? firstDay : addDays(shiftMonths(today, -12), 1);
      return { fromDay: from, toDay: today };
    }
  }
}

/** Default bucket for a range: weeks up to ~15 months, months beyond, years for > 6 years. */
export function defaultBucket(range: { fromDay: string; toDay: string }): ProgressBucket {
  const days = diffDays(range.fromDay, range.toDay);
  if (days > 6 * 366) return 'year';
  return days > 460 ? 'month' : 'week';
}

/** Scopes of the records page. */
export type RecordScope = 'allTime' | 'thisYear' | 'last12m';

/** First local day of a records scope as of `today` (null = all time): Jan 1, or one year back, as /records counts. */
export function recordScopeStart(scope: RecordScope, today: string): string | null {
  if (scope === 'thisYear') return `${today.slice(0, 4)}-01-01`;
  if (scope === 'last12m') return addDays(shiftMonths(today, -12), 1);
  return null;
}

/**
 * The fastest `n` attempts of a scope (by their local day, up to `today`), ranked from 1; ties go to the earlier
 * attempt, as in the server's all-time Top 10.
 */
export function scopedTop<T extends { startTs: number; tzMin: number; elapsedS: number }>(
  attempts: readonly T[],
  scope: RecordScope,
  today: string,
  n = 10,
): (T & { rank: number })[] {
  const from = recordScopeStart(scope, today);
  return attempts
    .filter((a) => {
      const day = dayKey(a.startTs, a.tzMin);
      return (from === null || day >= from) && day <= today;
    })
    .sort((a, b) => a.elapsedS - b.elapsedS || a.startTs - b.startTs)
    .slice(0, n)
    .map((a, i) => ({ ...a, rank: i + 1 }));
}
