import type { ReactNode } from 'react';
import { CalendarCheck, CalendarDays, Clock, Flame, PersonStanding, Sparkles, Target, Timer, Trophy } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ConsistencyOverview, StreakInfo } from '@cadence/shared';
import { Card, Delta, Skeleton } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { rangeLabel } from '../lib';

function StreakCard({
  icon: Icon,
  label,
  value,
  unit,
  hint,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <div className="flex items-center gap-1.5 text-xs font-medium text-fg-3">
        <Icon size={14} className="shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-3xl font-semibold tracking-tight text-fg">{value}</span>
        {unit && <span className="text-sm font-medium text-fg-3">{unit}</span>}
      </div>
      {hint && <div className="mt-1.5 text-xs text-fg-3">{hint}</div>}
    </Card>
  );
}

/** "Streak at risk" note: warning tone always paired with an icon and a label (wraps in narrow cards). */
export function PendingNote({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-start gap-1 rounded-md bg-warning/18 px-1.5 py-0.5 font-medium text-fg">
      <Clock size={12} className="mt-0.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </span>
  );
}

export function StreakCardsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-[118px] rounded-card" />
      ))}
    </div>
  );
}

/** Daily / weekly / ring streaks + active days this year. */
export function StreakCards({ data }: { data: ConsistencyOverview }) {
  const t = useT();
  const fmt = useFormat();
  const { daily, weekly, rings } = data.streaks;
  const dayUnit = (n: number) => t('consistency.common.dayUnit', { count: n });
  const weekUnit = (n: number) => t('consistency.common.weekUnit', { count: n });

  const currentHint = (s: StreakInfo) =>
    s.current === 0 ? (
      t('consistency.streaks.startToday')
    ) : s.pending ? (
      <PendingNote>{t('consistency.streaks.pendingDay')}</PendingNote>
    ) : (
      t('consistency.streaks.since', { date: fmt.day(s.currentStart!, 'dayShort') })
    );
  const ringHint = (s: StreakInfo) =>
    s.current > 0 && s.pending ? (
      <PendingNote>{t('consistency.streaks.pendingRing')}</PendingNote>
    ) : (
      t('consistency.streaks.best', { value: `${fmt.int(s.longest)} ${dayUnit(s.longest)}` })
    );
  const ring = (icon: LucideIcon, label: string, s: StreakInfo) => (
    <StreakCard icon={icon} label={label} value={fmt.int(s.current)} unit={dayUnit(s.current)} hint={ringHint(s)} />
  );
  const yearDelta = data.activeDays.thisYear - data.activeDays.lastYearToDate;

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <StreakCard
        icon={Flame}
        label={t('consistency.streaks.current')}
        value={fmt.int(daily.current)}
        unit={dayUnit(daily.current)}
        hint={currentHint(daily)}
      />
      <StreakCard
        icon={Trophy}
        label={t('consistency.streaks.longest')}
        value={fmt.int(daily.longest)}
        unit={dayUnit(daily.longest)}
        hint={daily.longestStart && daily.longestEnd ? rangeLabel(fmt, daily.longestStart, daily.longestEnd) : null}
      />
      <StreakCard
        icon={CalendarCheck}
        label={t('consistency.streaks.weekly')}
        value={fmt.int(weekly.current)}
        unit={weekUnit(weekly.current)}
        hint={
          weekly.current > 0 && weekly.pending ? (
            <PendingNote>{t('consistency.streaks.pendingWeek')}</PendingNote>
          ) : (
            t('consistency.streaks.best', { value: `${fmt.int(weekly.longest)} ${weekUnit(weekly.longest)}` })
          )
        }
      />
      <StreakCard
        icon={CalendarDays}
        label={t('consistency.streaks.activeDays', { year: data.activeDays.year })}
        value={fmt.int(data.activeDays.thisYear)}
        unit={dayUnit(data.activeDays.thisYear)}
        hint={
          data.activeDays.lastYearToDate > 0 ? (
            <span className="inline-flex flex-wrap items-center gap-1">
              <Delta value={yearDelta} text={fmt.signed(yearDelta)} />
              {t('consistency.streaks.vsLastYear')}
            </span>
          ) : (
            t('consistency.streaks.last30', { count: data.activeDays.last30 })
          )
        }
      />
      {rings && (
        <>
          {ring(Target, t('consistency.streaks.move'), rings.move)}
          {ring(Timer, t('consistency.streaks.exercise'), rings.exercise)}
          {ring(PersonStanding, t('consistency.streaks.stand'), rings.stand)}
          {ring(Sparkles, t('consistency.streaks.allRings'), rings.all)}
        </>
      )}
    </div>
  );
}
