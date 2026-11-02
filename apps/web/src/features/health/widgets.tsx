import type { ReactNode } from 'react';
import { Activity, ChevronRight, Footprints, HeartPulse, Moon, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import type { HealthSnapshot, SnapshotValue } from '@cadence/shared';
import { Card, CardHeader, ProgressBar, Skeleton, cn } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { Spark } from './components/Spark';
import { useDayLabel } from './components/MetricCard';
import { useMetricFormat } from './lib/metrics';

/**
 * Dashboard widgets of the "health" feature, placed on the home page by the activities feature.
 * Each widget renders its own <Card> and fetches its own data; return null when there is nothing to show.
 */

const RHR = 'HKQuantityTypeIdentifierRestingHeartRate';
const HRV = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN';
const STEPS = 'HKQuantityTypeIdentifierStepCount';
const SLEEP = 'HKCategoryTypeIdentifierSleepAnalysis';

function Tile({
  to,
  icon: Icon,
  label,
  value,
  unit,
  hint,
  spark,
  extra,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  value: string;
  unit?: string;
  hint?: ReactNode;
  spark: (number | null)[];
  extra?: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={cn('group block min-w-0 rounded-control p-2 -m-2 transition-colors hover:bg-surface-2 focus-visible:outline-2')}
      aria-label={`${label}: ${value} ${unit ?? ''}`.trim()}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-fg-3">
        <Icon size={14} className="shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-2xl font-semibold tracking-tight text-fg">{value}</span>
        {unit && <span className="text-sm font-medium text-fg-3">{unit}</span>}
      </div>
      {hint && <div className="mt-0.5 text-xs text-fg-3">{hint}</div>}
      <Spark data={spark} height={26} className="mt-2" ariaLabel={label} />
      {extra}
    </Link>
  );
}

/** Resting heart rate, HRV, last night's sleep and today's steps, each with a two-week sparkline. */
export function HealthSnapshotWidget() {
  const t = useT();
  const fmt = useFormat();
  const m = useMetricFormat();
  const dayLabel = useDayLabel();
  const q = useApi<HealthSnapshot>(['health', 'snapshot'], '/health/snapshot', undefined, { staleTime: 30_000 });

  if (q.isLoading) {
    return (
      <Card className="@container">
        <Skeleton className="h-4 w-40" />
        <div className="mt-4 grid grid-cols-2 gap-6 @lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i}>
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-2 h-7 w-24" />
              <Skeleton className="mt-3 h-6 w-full" />
            </div>
          ))}
        </div>
      </Card>
    );
  }
  const d = q.data;
  if (!d || (!d.restingHr && !d.hrv && !d.sleep && !d.steps)) return null;

  const simple = (v: SnapshotValue | null, metric: string, to: string, icon: LucideIcon, label: string) => {
    if (!v) return null;
    const p = m.parts(metric, v.value);
    return <Tile key={metric} to={to} icon={icon} label={label} value={p.value} unit={p.unit} hint={dayLabel(v.day)} spark={v.spark} />;
  };

  const sleep = d.sleep;
  const sleepPct = sleep ? sleep.value / sleep.goalMin : 0;

  return (
    <Card className="@container">
      <CardHeader
        title={t('health.widget.title')}
        subtitle={d.asOf ? t('health.common.asOf', { date: fmt.day(d.asOf, 'day') }) : undefined}
        icon={HeartPulse}
        actions={
          <Link to="/health" className="inline-flex items-center gap-0.5 text-xs font-medium text-accent-fg hover:underline">
            {t('health.widget.all')}
            <ChevronRight size={14} aria-hidden />
          </Link>
        }
      />
      <div className="grid grid-cols-2 gap-x-6 gap-y-6 @lg:grid-cols-4">
        {simple(d.restingHr, RHR, '/health/heart', HeartPulse, t('health.widget.restingHr'))}
        {simple(d.hrv, HRV, '/health/heart', Activity, t('health.widget.hrv'))}
        {sleep && (
          <Tile
            to="/health/sleep"
            icon={Moon}
            label={t('health.widget.sleep')}
            value={`${Math.floor(Math.round(sleep.value) / 60)}:${String(Math.round(sleep.value) % 60).padStart(2, '0')}`}
            unit="h"
            hint={
              <>
                {dayLabel(sleep.day)}
                {sleep.efficiency !== null && ` · ${t('health.widget.efficiency', { value: fmt.pct(sleep.efficiency) })}`}
              </>
            }
            extra={
              <ProgressBar
                value={sleepPct}
                height={4}
                color="var(--series-2)"
                className="mt-2"
                label={t('health.widget.goalProgress', { pct: fmt.pct(Math.min(sleepPct, 1)) })}
              />
            }
            spark={sleep.spark}
          />
        )}
        {simple(d.steps, STEPS, `/health/explorer/${STEPS}`, Footprints, m.name(STEPS))}
      </div>
    </Card>
  );
}
