import { ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import type { HealthMetricCard } from '@cadence/shared';
import { Card, Skeleton } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { addDays, todayKey } from '@/lib/time';
import { useMetricFormat } from '../lib/metrics';
import { Spark } from './Spark';
import { TrendDelta } from './TrendDelta';

/** "Today", "Yesterday" or a short weekday date. */
export function useDayLabel() {
  const t = useT();
  const fmt = useFormat();
  return (day: string | null | undefined): string => {
    if (!day) return '';
    const today = todayKey();
    if (day === today) return t('health.common.today');
    if (day === addDays(today, -1)) return t('health.common.yesterday');
    return fmt.day(day, 'weekdayShort');
  };
}

export function MetricCardSkeleton() {
  return (
    <Card className="h-[172px]">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-8 w-28" />
      <Skeleton className="mt-3 h-3 w-40" />
      <Skeleton className="mt-4 h-6 w-full" />
    </Card>
  );
}

/**
 * Overview card of one key metric: latest value, 30-day average with the correctly signed change versus the
 * previous 30 days (colored by whether up is good, always with arrow + sign), sparkline, link to the details.
 */
export function MetricCard({
  title,
  icon: Icon,
  to,
  metric,
  unit,
  card,
}: {
  title: string;
  icon: LucideIcon;
  to: string;
  /** Catalogue identifier used for formatting (sleep uses the SleepAnalysis identifier). */
  metric: string;
  unit?: string | null;
  card: HealthMetricCard;
}) {
  const t = useT();
  const m = useMetricFormat();
  const dayLabel = useDayLabel();
  const latest = m.parts(metric, card.latest, unit);
  const comparable = card.avg30 !== null && card.avgPrev30 !== null && Math.min(card.n30, card.nPrev30) >= 2;
  const delta = comparable ? m.delta(metric, card.avg30! - card.avgPrev30!, unit) : null;
  const avg = card.avg30 !== null ? m.value(metric, card.avg30, unit) : '–';

  return (
    <Link
      to={to}
      className="group block rounded-card focus-visible:outline-2 focus-visible:outline-offset-2"
      aria-label={`${title}: ${latest.value} ${latest.unit}`.trim()}
    >
      <Card className="h-full min-h-[172px] transition-colors group-hover:border-border-strong">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-fg-3">
            <Icon size={15} className="shrink-0" aria-hidden />
            <span className="truncate">{title}</span>
          </div>
          <ChevronRight size={15} className="shrink-0 text-fg-3 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
        </div>
        <div className="mt-2 flex items-baseline gap-1">
          <span className="text-2xl font-semibold tracking-tight text-fg">{latest.value}</span>
          {latest.unit && <span className="text-sm font-medium text-fg-3">{latest.unit}</span>}
          <span className="ml-1.5 truncate text-xs text-fg-3">{dayLabel(card.latestDay)}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-3">
          <span>
            {t('health.overview.avg30')} <span className="font-medium text-fg-2 tabular">{avg}</span>
          </span>
          {delta ? (
            <span className="inline-flex items-center gap-1" title={t('health.overview.vsPrev')}>
              <TrendDelta value={delta.value} text={delta.text} good={m.good(metric)} />
            </span>
          ) : (
            <span title={t('health.overview.notEnough')}>–</span>
          )}
        </div>
        <div className="mt-1 text-[11px] text-fg-3">{delta ? t('health.overview.vsPrev') : t('health.overview.notEnough')}</div>
        <Spark data={card.spark} height={30} className="mt-3" ariaLabel={title} />
      </Card>
    </Link>
  );
}
