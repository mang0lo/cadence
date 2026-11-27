/**
 * Dashboard widgets of the "progress" feature, placed on the home page by the activities feature.
 * Each widget renders its own <Card> and fetches its own data; return null when there is nothing to show.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowRight, CalendarDays, Gauge, Zap } from 'lucide-react';
import type { ProgressFtpResponse } from '@cadence/shared';
import { Card, CardHeader, Delta, ErrorState, Skeleton, Stat } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useFormat, type Formatter } from '@/lib/format';
import { useI18n, useT } from '@/lib/i18n';
import { sportLabel } from '@/lib/sports';
import { addDays, todayKey } from '@/lib/time';
import { useFitness, useSnapshot } from './api';
import { signedRounded } from './format';
import { FormZoneBadge } from './components/FormZoneBadge';
import { Spark } from './components/Spark';
import { durationLabel, isCycling } from './power';

function DetailsLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-xs font-medium text-fg-3 hover:text-accent-fg">
      {label}
      <ArrowRight size={13} aria-hidden />
    </Link>
  );
}

function WidgetSkeleton({ title, icon }: { title: ReactNode; icon: typeof Gauge }) {
  return (
    <Card>
      <CardHeader title={title} icon={icon} />
      <div className="grid grid-cols-2 gap-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
      <Skeleton className="mt-4 h-8" />
    </Card>
  );
}

/** Relative change as a Delta (absolute for counts; "new" when there was nothing before). */
function change(cur: number, prev: number, fmt: Formatter, t: (k: string) => string, absolute = false): ReactNode {
  if (cur === 0 && prev === 0) return null;
  if (absolute) return <Delta value={cur - prev} text={fmt.signed(cur - prev)} />;
  if (prev <= 0) return cur > 0 ? <Delta value={1} text={t('progress.compare.new')} /> : <Delta value={0} text="±0 %" />;
  const text = `${signedRounded(fmt, ((cur - prev) / prev) * 100)} %`;
  return <Delta value={text.startsWith('±') ? 0 : cur - prev} text={text} />;
}

/** This week vs last week (same weekdays) + 12-week sparkline. */
export function WeeklySnapshotWidget() {
  const t = useT();
  const fmt = useFormat();
  const q = useSnapshot();
  const d = q.data;
  const title = t('progress.widgets.snapshot.title');
  if (q.error)
    return (
      <Card>
        <CardHeader title={title} icon={CalendarDays} />
        <ErrorState error={q.error} />
      </Card>
    );
  if (!d) return <WidgetSkeleton title={title} icon={CalendarDays} />;
  const anything = d.weeks.some((w) => w.totals.count > 0);
  if (!anything) return null;
  const cur = d.current.totals;
  const prev = d.previous.totals;
  const full = d.previousFull.totals;
  const useDistance = d.weeks.some((w) => w.totals.distanceM > 0);
  const dist = fmt.distanceParts(cur.distanceM);
  const elev = fmt.elevationParts(cur.elevationM);
  const stat = (label: string, value: ReactNode, unit: string | undefined, delta: ReactNode, last: string) => (
    <Stat size="sm" label={label} value={value} unit={unit} delta={delta} hint={last} />
  );
  const spark = d.weeks.map((w) => (useDistance ? fmt.distanceValue(w.totals.distanceM) : w.totals.movingS / 3600));
  return (
    <Card>
      <CardHeader
        title={title}
        subtitle={`${fmt.day(d.current.fromDay, 'dayShort')} – ${fmt.day(addDays(d.current.fromDay, 6), 'dayShort')}`}
        icon={CalendarDays}
        actions={<DetailsLink to="/progress" label={t('progress.widgets.snapshot.details')} />}
      />
      <div className="grid grid-cols-2 gap-x-4 gap-y-4">
        {stat(
          t('common.distance'),
          dist.value,
          dist.unit,
          change(cur.distanceM, prev.distanceM, fmt, t),
          t('progress.widgets.snapshot.lastWeek', { value: fmt.distance(full.distanceM) }),
        )}
        {stat(
          t('common.movingTime'),
          fmt.durationShort(cur.movingS),
          undefined,
          change(cur.movingS, prev.movingS, fmt, t),
          t('progress.widgets.snapshot.lastWeek', { value: fmt.durationShort(full.movingS) }),
        )}
        {stat(
          t('progress.common.activities'),
          fmt.int(cur.count),
          undefined,
          change(cur.count, prev.count, fmt, t, true),
          t('progress.widgets.snapshot.lastWeek', { value: fmt.int(full.count) }),
        )}
        {stat(
          t('common.elevationGain'),
          elev.value,
          elev.unit,
          change(cur.elevationM, prev.elevationM, fmt, t),
          t('progress.widgets.snapshot.lastWeek', { value: fmt.elevation(full.elevationM) }),
        )}
      </div>
      {(cur.count > 0 || prev.count > 0) && <p className="mt-3 text-[11px] text-fg-3">{t('progress.widgets.snapshot.vsLastWeek')}</p>}
      <div className="mt-3 border-t border-border pt-3">
        <Spark
          data={spark}
          height={32}
          ariaLabel={t(useDistance ? 'progress.widgets.snapshot.sparkline' : 'progress.widgets.snapshot.sparklineTime')}
        />
        <div className="mt-1 text-[11px] text-fg-3">
          {t(useDistance ? 'progress.widgets.snapshot.sparkline' : 'progress.widgets.snapshot.sparklineTime')}
        </div>
      </div>
      {cur.count === 0 && <p className="mt-2 text-xs text-fg-3">{t('progress.widgets.snapshot.empty')}</p>}
    </Card>
  );
}

/** Fitness / fatigue / form with the form zone and a 90-day fitness sparkline. */
export function FitnessWidget() {
  const t = useT();
  const fmt = useFormat();
  const today = todayKey();
  const q = useFitness('all', { fromDay: addDays(today, -89), toDay: today });
  const d = q.data;
  const title = t('progress.widgets.fitness.title');
  if (q.error)
    return (
      <Card>
        <CardHeader title={title} icon={Gauge} />
        <ErrorState error={q.error} />
      </Card>
    );
  if (!d) return <WidgetSkeleton title={title} icon={Gauge} />;
  const c = d.current;
  if (!c || !d.days.some((x) => x.ctl > 0.5)) return null;
  return (
    <Card>
      <CardHeader
        title={title}
        icon={Gauge}
        actions={<DetailsLink to="/progress/fitness" label={t('progress.widgets.fitness.details')} />}
      />
      <div className="grid grid-cols-3 gap-3">
        <Stat size="sm" label={t('progress.fitness.stats.fitness')} value={fmt.int(c.ctl)} />
        <Stat size="sm" label={t('progress.fitness.stats.fatigue')} value={fmt.int(c.atl)} />
        <Stat size="sm" label={t('progress.fitness.stats.form')} value={fmt.signed(Math.round(c.tsb))} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <FormZoneBadge zone={c.zone} />
        <span className="text-xs text-fg-3">{t(`progress.fitness.zoneHelp.${c.zone}`)}</span>
      </div>
      <div className="mt-4 border-t border-border pt-3">
        <Spark data={d.days.map((x) => x.ctl)} height={32} ariaLabel={t('progress.widgets.fitness.sparkline')} />
        <div className="mt-1 text-[11px] text-fg-3">{t('progress.widgets.fitness.sparkline')}</div>
      </div>
    </Card>
  );
}

/**
 * FTP (threshold) estimate and the 5 / 20 minute peak power of the same window (6 weeks, or 90 days when the
 * estimate had to fall back), for the default power sport. Renders nothing without power data (no power meter,
 * no Apple Watch running power).
 */
export function PowerWidget() {
  const t = useT();
  const fmt = useFormat();
  const { lang } = useI18n();
  // one cheap request: the estimate of the default power sport with the bests of its window, without the monthly
  // history the power page charts
  const ftp = useApi<ProgressFtpResponse>(['progress', 'power-ftp'], '/progress/power/ftp', { today: todayKey(), history: 0 });
  const title = t('progress.widgets.power.title');
  if (ftp.error)
    return (
      <Card>
        <CardHeader title={title} icon={Zap} />
        <ErrorState error={ftp.error} />
      </Card>
    );
  if (!ftp.data) return <WidgetSkeleton title={title} icon={Zap} />;
  const d = ftp.data;
  if (!d.sports.length) return null;
  const period = d.windowDays === 90 ? '90d' : '42d';
  const peak = (s: number) => d.windowBests.find((p) => p.durationS === s);
  const tile = (s: number) => {
    const p = peak(s);
    return (
      <Stat
        size="sm"
        label={durationLabel(t, fmt, s)}
        value={p ? fmt.int(p.watts) : '–'}
        unit={p ? 'W' : undefined}
        hint={p?.wkg != null ? `${fmt.num(p.wkg, 1)} W/kg` : undefined}
      />
    );
  };
  return (
    <Card>
      <CardHeader
        title={title}
        subtitle={sportLabel(d.sport, lang)}
        icon={Zap}
        actions={<DetailsLink to={`/progress/power?sport=${d.sport}`} label={t('progress.widgets.power.details')} />}
      />
      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3">
        <Stat
          size="sm"
          label={t(isCycling(d.sport) ? 'progress.widgets.power.ftp' : 'progress.widgets.power.threshold')}
          value={d.ftp !== null ? fmt.int(d.ftp) : '–'}
          unit={d.ftp !== null ? 'W' : undefined}
          hint={d.ftpWkg !== null ? `${fmt.num(d.ftpWkg, 2)} W/kg` : undefined}
        />
        {tile(300)}
        {tile(1200)}
      </div>
      <p className="mt-3 text-[11px] text-fg-3">{t(period === '90d' ? 'progress.widgets.power.note90' : 'progress.widgets.power.note')}</p>
    </Card>
  );
}
