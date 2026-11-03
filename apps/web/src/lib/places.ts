import { placeName, type WorkoutSummary } from '@cadence/shared';
import type { Lang } from './i18n';

export { placeName };

/** Where an activity took place: "Warnemünde", or "Rostock → Berlin" for a one-way activity; null without GPS. */
export function activityPlace(w: Pick<WorkoutSummary, 'place' | 'placeEnd'>, lang: Lang): string | null {
  if (!w.place) return null;
  const from = placeName(w.place, lang);
  return w.placeEnd ? `${from} → ${placeName(w.placeEnd, lang)}` : from;
}
