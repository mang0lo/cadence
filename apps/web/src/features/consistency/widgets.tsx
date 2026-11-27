/**
 * Dashboard widgets of the "consistency" feature, registered in ./index.tsx (FeatureModule.widgets).
 * Each widget renders its own <Card> and fetches its own data; it returns null when there is nothing to show.
 *
 *   <StreakWidget />    current daily streak, longest + weekly streak, the last 14 days
 *   <GoalsWidget />     the first goals (daily ones first) with progress, status and a check-off button
 *   <CalendarWidget />  activity calendar of the last 18 weeks
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CalendarRange, ChevronRight, Flame, Target } from 'lucide-react';
import type { GoalPeriod } from '@cadence/shared';
import { CalendarHeatmap } from '@/components/charts/CalendarHeatmap';
import { Card, CardHeader, ErrorState, Skeleton, cn } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { useCalendar, useConsistencyMutations, useGoals, useStreaks } from './api';
import { GoalCheckButton, GoalIcon, GoalProgressBar, GoalStatusBadge } from './components/GoalParts';
import { PendingNote } from './components/StreakCards';
import { formatGoalValue, goalTitle, reachedRounding } from './lib';

function MoreLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="inline-flex items-center gap-0.5 text-xs font-medium text-fg-3 hover:text-fg">
      {label}
      <ChevronRight size={14} aria-hidden />
    </Link>
  );
}

function WidgetSkeleton({ height }: { height: number }) {
  return (
    <Card aria-busy>
      <Skeleton className="mb-3 h-4 w-32" />
      <div style={{ height: height - 28 }} className="animate-pulse rounded-control bg-surface-2" />
    </Card>
  );
}

export function StreakWidget() {
  const { t } = useI18n();
  const fmt = useFormat();
  const q = useStreaks();
  const s = q.data;
  if (q.error)
    return (
      <Card>
        <ErrorState error={q.error} />
      </Card>
    );
  if (!s) return <WidgetSkeleton height={180} />;
  if (s.daily.longest === 0 && !s.rings) return null;
  const dayUnit = (n: number) => t('consistency.common.dayUnit', { count: n });
  const weekUnit = (n: number) => t('consistency.common.weekUnit', { count: n });
  return (
    <Card>
      <CardHeader
        title={t('consistency.widgets.streak')}
        icon={Flame}
        actions={<MoreLink to="/consistency" label={t('consistency.widgets.more')} />}
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-baseline gap-1">
            <span className="text-4xl font-semibold tracking-tight text-fg">{fmt.int(s.daily.current)}</span>
            <span className="text-sm font-medium text-fg-3">{dayUnit(s.daily.current)}</span>
          </div>
          <div className="mt-1 text-xs text-fg-3">
            {s.daily.current === 0 ? (
              t('consistency.streaks.startToday')
            ) : s.daily.pending ? (
              <PendingNote>{t('consistency.streaks.pendingDay')}</PendingNote>
            ) : (
              t('consistency.streaks.since', { date: fmt.day(s.daily.currentStart!, 'dayShort') })
            )}
          </div>
        </div>
        <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-fg-3">{t('consistency.streaks.longest')}</dt>
          <dd className="text-right font-medium tabular text-fg">
            {fmt.int(s.daily.longest)} {dayUnit(s.daily.longest)}
          </dd>
          <dt className="text-fg-3">{t('consistency.streaks.weekly')}</dt>
          <dd className="text-right font-medium tabular text-fg">
            {fmt.int(s.weekly.current)} {weekUnit(s.weekly.current)}
          </dd>
          {s.rings && (
            <>
              <dt className="text-fg-3">{t('consistency.streaks.move')}</dt>
              <dd className="text-right font-medium tabular text-fg">
                {fmt.int(s.rings.move.current)} {dayUnit(s.rings.move.current)}
              </dd>
            </>
          )}
        </dl>
      </div>
      <div className="mt-4" role="list" aria-label={t('consistency.widgets.last14')}>
        <div className="grid grid-cols-[repeat(14,minmax(0,1fr))] gap-1">
          {s.recent.map((d) => {
            const label = `${fmt.day(d.day, 'weekdayShort')}: ${d.active ? t('consistency.widgets.active') : t('consistency.widgets.rest')}`;
            return (
              <span
                key={d.day}
                role="listitem"
                title={label}
                aria-label={label}
                className={cn(
                  'h-6 rounded-[5px]',
                  d.active ? 'bg-accent' : 'bg-surface-3',
                  d.day === s.asOf && 'ring-2 ring-fg/60 ring-offset-1 ring-offset-surface',
                )}
              />
            );
          })}
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-fg-3">
          <span>{fmt.day(s.recent[0]!.day, 'dayShort')}</span>
          <span>{s.asOf === s.today ? t('common.today') : fmt.day(s.asOf, 'dayShort')}</span>
        </div>
      </div>
    </Card>
  );
}

const PERIOD_ORDER: Record<GoalPeriod, number> = { day: 0, week: 1, month: 2, year: 3 };

export function GoalsWidget() {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const q = useGoals();
  const { checkGoal } = useConsistencyMutations();
  // the check marks are server state without an optimistic update: a failed request must say so
  const [checkError, setCheckError] = useState<unknown>(null);
  const check = (id: number, done: boolean, day: string) => {
    setCheckError(null);
    void checkGoal(id, done, day).catch(setCheckError);
  };
  // daily goals first (they are the ones to tick off today), then the shortest periods; a few more when there are
  // daily goals so the weekly ones stay in view
  const goals = useMemo(() => {
    const sorted = [...(q.data?.goals ?? [])].sort(
      (a, b) => PERIOD_ORDER[a.period] - PERIOD_ORDER[b.period] || a.position - b.position,
    );
    const daily = sorted.filter((g) => g.period === 'day').length;
    return sorted.slice(0, Math.min(5, 3 + daily));
  }, [q.data]);
  if (q.error)
    return (
      <Card>
        <ErrorState error={q.error} />
      </Card>
    );
  if (!q.data) return <WidgetSkeleton height={220} />;
  if (!goals.length) return null;
  return (
    <Card>
      <CardHeader
        title={t('consistency.widgets.goals')}
        icon={Target}
        actions={<MoreLink to="/goals" label={t('consistency.widgets.allGoals')} />}
      />
      <ul className="space-y-4">
        {goals.map((g) => {
          const title = goalTitle(t, lang, g);
          return (
            <li key={g.id} className="min-w-0">
              <div className="mb-1.5 flex items-center gap-2">
                <GoalIcon sport={g.sport} size={22} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-fg">{title}</div>
                </div>
                <GoalCheckButton goal={g} compact onCheck={(done, day) => check(g.id, done, day)} />
              </div>
              <GoalProgressBar current={g.current} label={title} height={8} />
              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-fg-3">
                <span className="tabular">
                  <span className="font-medium text-fg">
                    {formatGoalValue(fmt, t, g.metric, g.current.value, reachedRounding(g.current.value, g.current.target))}
                  </span>
                  {' / '}
                  {formatGoalValue(fmt, t, g.metric, g.current.target)}
                  {' · '}
                  {t(`consistency.goals.current.${g.period}`)}
                </span>
                <GoalStatusBadge status={g.current.status} checked={g.current.checked} />
              </div>
            </li>
          );
        })}
      </ul>
      {checkError ? <ErrorState error={checkError} className="mt-3" /> : null}
    </Card>
  );
}

const WEEKS = 18;

export function CalendarWidget() {
  const { t } = useI18n();
  const fmt = useFormat();
  const { settings } = useSettings();
  const q = useCalendar({ weeks: WEEKS });
  const d = q.data;
  const values = useMemo(() => {
    const out: Record<string, number> = {};
    for (const x of d?.days ?? []) if (x.count > 0) out[x.day] = x.durationS / 60;
    return out;
  }, [d]);
  if (q.error)
    return (
      <Card>
        <ErrorState error={q.error} />
      </Card>
    );
  if (!d) return <WidgetSkeleton height={190} />;
  const active = (d.days ?? []).filter((x) => x.count > 0);
  if (!active.length && !d.days.length) return null;
  const totalS = active.reduce((s, x) => s + x.durationS, 0);
  return (
    <Card>
      <CardHeader
        title={t('consistency.widgets.calendar', { count: WEEKS })}
        subtitle={t('consistency.calendar.summary', { days: t('common.days', { count: active.length }), time: fmt.durationShort(totalS) })}
        icon={CalendarRange}
        actions={<MoreLink to="/consistency" label={t('consistency.widgets.more')} />}
      />
      <CalendarHeatmap
        values={values}
        from={d.from}
        to={d.to}
        weekStart={settings.weekStart}
        cell={13}
        gap={3}
        tooltip={(day, v) => (
          <>
            <div className="font-semibold">{v ? fmt.durationShort(v * 60) : t('consistency.calendar.noActivity')}</div>
            <div className="text-fg-3">{fmt.day(day, 'weekdayShort')}</div>
          </>
        )}
      />
    </Card>
  );
}
