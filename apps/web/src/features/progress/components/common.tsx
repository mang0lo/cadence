import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { workoutTitle, type ProgressSport } from '@cadence/shared';
import { Card, CardHeader, Delta, Select, cn } from '@/components/ui';
import { useI18n, useT } from '@/lib/i18n';
import { sportLabel } from '@/lib/sports';

/** Placeholder with the exact height of the chart it stands in for (no layout jump). */
export function ChartSkeleton({ height, className }: { height: number; className?: string }) {
  return <div className={cn('w-full animate-pulse rounded-control bg-surface-2', className)} style={{ height }} />;
}

/** A card-shaped skeleton for the first load of a section. */
export function CardSkeleton({ title, height = 260, className }: { title: ReactNode; height?: number; className?: string }) {
  return (
    <Card className={cn('min-w-0', className)}>
      <CardHeader title={title} />
      <ChartSkeleton height={height} />
    </Card>
  );
}

/**
 * Signed change with direction icon. With `better` it is colored good/critical (Delta); without it the
 * change is neutral (muted, still with an arrow).
 */
export function ChangeBadge({
  value,
  text,
  better,
  className,
}: {
  value: number;
  text: string;
  better: 'up' | 'down' | null;
  className?: string;
}) {
  if (better) return <Delta value={value} text={text} upIsGood={better === 'up'} className={className} />;
  const Icon = value > 0 ? ArrowUpRight : value < 0 ? ArrowDownRight : Minus;
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-xs font-medium text-fg-3', className)}>
      <Icon size={14} aria-hidden />
      {text}
    </span>
  );
}

/** Sport filter: "All sports" + every sport with activities (most frequent first). */
export function SportSelect({
  value,
  onChange,
  sports,
  allowAll = true,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  sports: { sport: string; count?: number; workouts?: number }[] | ProgressSport[];
  allowAll?: boolean;
  className?: string;
}) {
  const t = useT();
  const { lang } = useI18n();
  const options = [
    ...(allowAll ? [{ value: 'all', label: t('common.allSports') }] : []),
    ...sports.map((s) => {
      const n = 'count' in s && s.count !== undefined ? s.count : 'workouts' in s ? s.workouts : undefined;
      return { value: s.sport, label: n !== undefined ? `${sportLabel(s.sport, lang)} (${n})` : sportLabel(s.sport, lang) };
    }),
  ];
  // Select's own `w-auto` loses against the `w-full` of the shared control class, so size it via a wrapper
  return (
    <div className={cn('w-52 max-w-full', className)}>
      <Select value={value} onChange={onChange} options={options} aria-label={t('progress.filters.sport')} />
    </div>
  );
}

/** Link to an activity with its localized title. */
export function ActivityLink({
  w,
  className,
}: {
  w: { id?: number; workoutId?: number; name: string; sport: string; startTs: number; tzMin: number };
  className?: string;
}) {
  const { lang } = useI18n();
  const id = w.workoutId ?? w.id;
  return (
    <Link to={`/activities/${id}`} className={cn('font-medium text-fg hover:text-accent-fg hover:underline', className)}>
      {workoutTitle(w, lang)}
    </Link>
  );
}
