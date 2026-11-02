import { MapPin } from 'lucide-react';
import type { WorkoutSummary } from '@cadence/shared';
import { cn } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { activityPlace } from '@/lib/places';

/** "📍 Warnemünde" / "📍 Rostock → Berlin" for an activity with GPS; nothing without. */
export function PlaceText({
  w,
  className,
  size = 12,
}: {
  w: Pick<WorkoutSummary, 'place' | 'placeEnd'>;
  className?: string;
  size?: number;
}) {
  const { t, lang } = useI18n();
  const text = activityPlace(w, lang);
  if (!text) return null;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-0.5', className)} title={text}>
      <MapPin size={size} aria-label={t('common.place')} className="shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  );
}
