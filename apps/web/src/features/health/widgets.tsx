import type { ReactNode } from 'react';
import { Activity, BatteryCharging, ChevronRight, Footprints, HeartPulse, Moon, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import type { HealthSnapshot, SnapshotValue } from '@cadence/shared';
import { Card, CardHeader, ProgressBar, Skeleton, cn } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { todayKey } from '@/lib/time';
import { Spark } from './components/Spark';
import { useDayLabel } from './components/MetricCard';
import { ReadinessBandBadge, ReadinessRing, ReasonList } from './components/readiness/ReadinessRing';
import { useMetricFormat } from './lib/metrics';
import { useReadiness } from './lib/readiness';

/**
 * Dashboard widgets of the "health" feature, placed on the home page by the activities feature.
 * Each widget renders its own <Card> and fetches its own data; return null when there is nothing to show.
 */

// ---------------------------------------------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------------------------------------------

/**
 * Readiness of the latest day with data: score ring, band, the main reasons and the last two weeks. `overview` is the
 * wide variant at the top of the health overview. Renders nothing until there is a score (not enough data yet,
 * loading, errors) – the readiness page explains what is missing.
 */
export function ReadinessCard({ variant = 'widget' }: { variant?: 'widget' | 'overview' }) {
  const t = useT();
  const fmt = useFormat();
  const dayLabel = useDayLabel();
  const q = useReadiness(undefined, 14);
  const c = q.data?.current;
  if (!c || c.score === null || !c.band) return null;
  const isToday = c.day === todayKey();
  const spark = (q.data?.history ?? []).map((h) => h.score);

  if (variant === 'overview') {
    return (
      <Card className="@container">
        <CardHeader
          title={t('health.readiness.overview.title')}
          subtitle={dayLabel(c.day)}
          icon={BatteryCharging}
          actions={
            <Link to="/health/readiness" className="inline-flex items-center gap-0.5 text-xs font-medium text-accent-fg hover:underline">
              {t('health.readiness.overview.open')}
              <ChevronRight size={14} aria-hidden />
            </Link>
          }
        />
        <div className="grid grid-cols-[minmax(0,1fr)] items-center gap-4 @xl:grid-cols-[auto_minmax(0,1fr)]">
          <div className="flex min-w-0 items-center gap-4">
            <ReadinessRing score={c.score} band={c.band} size={96} />
            <div className="min-w-0 max-w-[22rem]">
              <ReadinessBandBadge band={c.band} />
              <p className="mt-1.5 text-sm text-fg">{t(`health.readiness.advice.${c.band}`)}</p>
            </div>
          </div>
          <ReasonList day={c} max={3} className="@xl:border-l @xl:border-border @xl:py-1 @xl:pl-6" />
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title={isToday ? t('health.readiness.widget.title') : t('health.readiness.widget.titleDay')}
        subtitle={isToday ? undefined : t('health.common.asOf', { date: fmt.day(c.day, 'day') })}
        icon={BatteryCharging}
        actions={
          <Link to="/health/readiness" className="inline-flex items-center gap-0.5 text-xs font-medium text-accent-fg hover:underline">
            {t('health.readiness.widget.details')}
            <ChevronRight size={14} aria-hidden />
          </Link>
        }
      />
      <div className="flex items-center gap-4">
        <ReadinessRing score={c.score} band={c.band} size={84} />
        <div className="min-w-0">
          <ReadinessBandBadge band={c.band} />
          <p className="mt-1.5 text-xs text-fg-2">{t(`health.readiness.advice.${c.band}`)}</p>
        </div>
      </div>
      <ReasonList day={c} max={2} className="mt-3" />
      {spark.filter((s) => s !== null).length >= 2 && (
        <div className="mt-3 border-t border-border pt-3">
          <Spark data={spark} height={28} ariaLabel={t('health.readiness.widget.trend')} />
          <div className="mt-1 text-[11px] text-fg-3">{t('health.readiness.widget.trend')}</div>
        </div>
      )}
    </Card>
  );
}

/** "Readiness today" dashboard widget. */
export function ReadinessWidget() {
  return <ReadinessCard variant="widget" />;
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------------------------------------------

const RHR = 'HKQuantityTypeIdentifierRestingHeartRate';
const HRV = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN';
const STEPS = 'HKQuantityTypeIdentifierStepCount';

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

/**
 * The health slot of the dashboard: the readiness card (when there is a score) above the snapshot card. Both are
 * separate cards; the dashboard can also list `ReadinessWidget` and `HealthSnapshotCard` as two widgets of their own.
 */
export function HealthSnapshotWidget() {
  return (
    <>
      <ReadinessWidget />
      <HealthSnapshotCard />
    </>
  );
}

/** Resting heart rate, HRV, last night's sleep and today's steps, each with a two-week sparkline. */
export function HealthSnapshotCard() {
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
