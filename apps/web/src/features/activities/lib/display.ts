import { BEST_EFFORTS, sportInfo, type WorkoutSummary } from '@cadence/shared';
import type { Formatter } from '@/lib/format';
import type { Lang, TFunction } from '@/lib/i18n';

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
    if (w.hasRoute && (w.elevationGainM ?? 0) >= 1) {
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
