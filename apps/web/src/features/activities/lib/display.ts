import { BEST_EFFORTS, M_PER_KM, M_PER_MI, sportInfo, type WorkoutSummary } from '@cadence/shared';
import { clock, type Formatter } from '@/lib/format';
import type { Lang, TFunction } from '@/lib/i18n';
import { dayKey, diffDays, startOfWeek, todayKey, weekday } from '@/lib/time';

/** "UTC+01:00" for an offset in minutes. */
export function tzLabel(tzMin: number): string {
  const sign = tzMin < 0 ? '−' : '+';
  const a = Math.abs(tzMin);
  const h = String(Math.floor(a / 60)).padStart(2, '0');
  const m = String(a % 60).padStart(2, '0');
  return `UTC${sign}${h}:${m}`;
}

/** Localized label of a best effort key ('5k' → "5K" / "5 km"). */
export function effortLabel(sport: string, key: string, lang: Lang): string {
  const def = (BEST_EFFORTS[sport] ?? Object.values(BEST_EFFORTS).flat()).find((d) => d.key === key);
  return def ? def.label[lang] : key;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : '')).toUpperCase();
}

export interface StatItem {
  key: string;
  label: string;
  value: string;
  unit?: string;
}

/** Short distances (swims) in m / yd as value + unit. */
export function shortDistanceParts(m: number, fmt: Formatter): { value: string; unit: string } {
  return fmt.units === 'imperial' ? { value: fmt.int(m / 0.9144), unit: 'yd' } : { value: fmt.int(m), unit: 'm' };
}

/** Whether a sport shows pace (min/km) rather than speed. */
export const isPaceSport = (sport: string) => {
  const m = sportInfo(sport).speedMode;
  return m === 'pace' || m === 'pace100';
};

/** Label for the speed metric of a sport: "Pace" or "Speed". */
export function speedLabel(sport: string, t: TFunction): string {
  return isPaceSport(sport) ? t('common.pace') : t('common.speed');
}

/** Cycling sports (ride, handcycle): cadence in rpm, power with an FTP. */
export const isCycling = (sport: string) => sportInfo(sport).group === 'cycle';

/** Cadence unit of a sport (the same rule as fmt.cadence). */
export const cadenceUnit = (sport: string) => (isCycling(sport) ? 'rpm' : 'spm');

/** Meters per pace unit: 100 m / 100 yd for swims (pace100), else 1 km / 1 mi. */
export function paceUnitM(sport: string, units: Formatter['units']): number {
  const imperial = units === 'imperial';
  if (sportInfo(sport).speedMode === 'pace100') return imperial ? 91.44 : 100;
  return imperial ? M_PER_MI : M_PER_KM;
}

/**
 * The number charts, axes and legends show for a speed (m/s), in the unit of fmt.paceParts(·, sport): seconds per
 * km / mi (per 100 m / 100 yd for swims) for pace sports, km/h or mph otherwise. NaN without a speed.
 */
export function paceValue(mps: number, sport: string, units: Formatter['units']): number {
  if (!(mps > 0)) return NaN;
  if (isPaceSport(sport)) return paceUnitM(sport, units) / mps;
  return units === 'imperial' ? mps / (M_PER_MI / 3600) : mps * 3.6;
}

/**
 * A − B of two speeds (m/s) as the compare pages show it: the pace difference for pace sports ("+0:12 /km", positive
 * = A slower), else the speed difference ("−1.2 km/h"). From the speeds themselves (also below the walking speed the
 * charts hide); null unless both are known. `value` is the shown difference (rounded), for its direction.
 */
export function speedDiff(a: number, b: number, sport: string, fmt: Formatter): { value: number; text: string } | null {
  const d = paceValue(a, sport, fmt.units) - paceValue(b, sport, fmt.units);
  if (!Number.isFinite(d)) return null;
  const unit = fmt.paceParts(1, sport).unit;
  if (isPaceSport(sport)) {
    const s = Math.round(d);
    return { value: s, text: `${s > 0 ? '+' : s < 0 ? '−' : '±'}${clock(Math.abs(s))} ${unit}` };
  }
  return { value: Math.round(d * 10) / 10, text: `${fmt.signed(d, 1)} ${unit}` };
}

/** Axis tick of a duration in minutes: "0", "30m", "2h" (en) / "30 Min.", "2 Std." (de). */
export function minutesTick(min: number, fmt: Formatter): string {
  return min === 0 ? '0' : fmt.durationShort(min * 60);
}

/**
 * Value axis for minutes up to `maxMin`: at most three steps above 0, of 15 or 30 minutes up to an hour and of whole
 * hours beyond, so every minutesTick label is exact (never "2h" for a 90-minute tick).
 */
export function minutesAxis(maxMin: number): { max: number; interval: number } {
  for (const step of [15, 30, 60, 120, 180, 240, 360, 480, 720]) {
    const n = Math.max(1, Math.ceil(maxMin / step));
    if (n <= 3 && (step >= 60 || n * step <= 60)) return { max: n * step, interval: step };
  }
  const step = Math.ceil(maxMin / 3 / 1440) * 1440;
  return { max: 3 * step, interval: step };
}

/**
 * How long ago an activity was, by the calendar: minutes or hours on its own day, then calendar days ("yesterday" is
 * the day before today, never 30 hours ago two days back), calendar weeks from `weekStart` ("last week"), months and
 * years. `ts`/`tzMin` give the activity's local day; `now` (unix s) and `today` (browser day key) are the reference.
 */
export function relativeTime(
  ts: number,
  tzMin: number,
  fmt: Formatter,
  weekStart: 0 | 1,
  now = Date.now() / 1000,
  today = todayKey(),
): string {
  const rtf = new Intl.RelativeTimeFormat(fmt.locale, { numeric: 'auto' });
  const day = dayKey(ts, tzMin);
  const days = diffDays(day, today);
  if (days <= 0) {
    const diff = ts - now;
    return Math.abs(diff) < 3600 ? rtf.format(Math.round(diff / 60), 'minute') : rtf.format(Math.round(diff / 3600), 'hour');
  }
  if (days < 7) return rtf.format(-days, 'day');
  const weeks = diffDays(startOfWeek(day, weekStart), startOfWeek(today, weekStart)) / 7;
  if (weeks < 5) return rtf.format(-weeks, 'week');
  const monthIndex = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
  const months = monthIndex(today) - monthIndex(day);
  if (months < 12) return rtf.format(-Math.max(1, months), 'month');
  return rtf.format(-Math.max(1, Number(today.slice(0, 4)) - Number(day.slice(0, 4))), 'year');
}

/** Short weekday name of a day key ("Tue", "Di."), whatever the locale's date pattern looks like. */
export function weekdayShort(day: string, fmt: Formatter): string {
  return fmt.weekdayNames(0)[weekday(day)]!;
}

/**
 * Elevation gain to show for a workout (the detail page's rule): also without a route, where it comes from the
 * workout's own data (a route file missing from the export, a FIT total ascent) — the list sorts by it and its totals
 * add it up. Null when unknown, and without a route when it is zero.
 */
export function shownGain(w: Pick<WorkoutSummary, 'hasRoute' | 'elevationGainM'>): number | null {
  const g = w.elevationGainM;
  return g !== null && (w.hasRoute || g > 0) ? g : null;
}

/** Sport-specific key stats of a workout for cards and list rows. */
export function keyStats(w: WorkoutSummary, fmt: Formatter, t: TFunction, max = 4): StatItem[] {
  const info = sportInfo(w.sport);
  const time = w.movingS ?? w.durationS;
  const out: StatItem[] = [];
  const hasDistance = info.distance && (w.distanceM ?? 0) > 0;
  if (hasDistance) {
    const d = w.sport === 'swim' ? shortDistanceParts(w.distanceM!, fmt) : fmt.distanceParts(w.distanceM);
    out.push({ key: 'distance', label: t('common.distance'), value: d.value, unit: d.unit });
    if (info.speedMode !== 'none' && w.avgSpeed) {
      const p = fmt.paceParts(w.avgSpeed, w.sport);
      out.push({ key: 'pace', label: speedLabel(w.sport, t), value: p.value, unit: p.unit });
    }
    out.push({ key: 'time', label: t('common.movingTime'), value: fmt.duration(time) });
    if ((shownGain(w) ?? 0) >= 1) {
      const e = fmt.elevationParts(w.elevationGainM);
      out.push({ key: 'elevation', label: t('common.elevationGain'), value: e.value, unit: e.unit });
    }
  } else {
    out.push({ key: 'time', label: t('common.duration'), value: fmt.duration(w.durationS) });
    if (w.avgHr) out.push({ key: 'hr', label: t('common.avgHr'), value: fmt.int(w.avgHr), unit: 'bpm' });
    if (w.energyKcal) out.push({ key: 'kcal', label: t('common.calories'), value: fmt.int(w.energyKcal), unit: 'kcal' });
  }
  if (w.effort && out.length < max) out.push({ key: 'effort', label: t('common.effort'), value: fmt.int(w.effort) });
  if (hasDistance && w.avgHr && out.length < max) out.push({ key: 'hr', label: t('common.avgHr'), value: fmt.int(w.avgHr), unit: 'bpm' });
  return out.slice(0, max);
}
