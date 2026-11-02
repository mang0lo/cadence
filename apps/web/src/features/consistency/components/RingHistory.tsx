import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Target } from 'lucide-react';
import type { CalendarDay, CalendarResponse } from '@cadence/shared';
import { Card, CardHeader, EmptyState, Hint, IconButton, Skeleton } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { weekday } from '@/lib/time';
import { monthDays, RINGS, type Ring } from '../lib';
import { RingGlyph, RingLegend } from './RingGlyph';

const closed = (v: number | null) => v !== null && v >= 0.9999;

/** Daily ring glyphs for one month of the selected year, laid out as a calendar. */
export function RingHistoryCard({
  year,
  weekStart,
  data,
}: {
  year: number;
  weekStart: 0 | 1;
  data: CalendarResponse | undefined;
}) {
  const t = useT();
  const fmt = useFormat();
  const byDay = useMemo(() => new Map((data?.days ?? []).map((d) => [d.day, d])), [data]);
  const months = useMemo(
    () =>
      [...new Set((data?.days ?? []).filter((d) => d.move !== null || d.exercise !== null || d.stand !== null).map((d) => d.day.slice(0, 7)))]
        .filter((m) => m.startsWith(String(year)))
        .sort(),
    [data, year],
  );
  const [month, setMonth] = useState<string | null>(null);
  useEffect(() => {
    if (!month || !months.includes(month)) setMonth(months[months.length - 1] ?? null);
  }, [months, month]);

  const labels: Record<Ring, string> = {
    move: t('consistency.rings.move'),
    exercise: t('consistency.rings.exercise'),
    stand: t('consistency.rings.stand'),
  };
  const idx = month ? months.indexOf(month) : -1;
  const days = month ? monthDays(month) : [];
  const lead = days.length ? (weekday(days[0]!) - weekStart + 7) % 7 : 0;
  const withRings = days.map((d) => byDay.get(d)).filter((d): d is CalendarDay => !!d && d.move !== null);
  const counts = Object.fromEntries(RINGS.map((r) => [r, withRings.filter((d) => closed(d[r])).length])) as Record<Ring, number>;
  const perfect = withRings.filter((d) => RINGS.every((r) => closed(d[r]))).length;

  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader
        title={t('consistency.rings.history')}
        subtitle={month ? fmt.day(`${month}-01`, 'month') : undefined}
        icon={Target}
        actions={
          months.length > 0 && (
            <>
              <IconButton
                icon={ChevronLeft}
                label={t('consistency.rings.prevMonth')}
                disabled={idx <= 0}
                className="disabled:opacity-30"
                onClick={() => setMonth(months[idx - 1]!)}
              />
              <IconButton
                icon={ChevronRight}
                label={t('consistency.rings.nextMonth')}
                disabled={idx < 0 || idx >= months.length - 1}
                className="disabled:opacity-30"
                onClick={() => setMonth(months[idx + 1]!)}
              />
            </>
          )
        }
      />
      {!data ? (
        <Skeleton className="h-64" />
      ) : !month ? (
        <EmptyState className="py-10" title={t('consistency.rings.noData')} />
      ) : (
        <>
          <div className="grid grid-cols-7 gap-1 text-center">
            {fmt.weekdayNames(weekStart, 'narrow').map((n, i) => (
              <div key={i} className="pb-1 text-[11px] font-medium text-fg-3">
                {n}
              </div>
            ))}
            {Array.from({ length: lead }, (_, i) => (
              <div key={`b${i}`} />
            ))}
            {days.map((day) => {
              const d = byDay.get(day);
              const has = !!d && (d.move !== null || d.exercise !== null || d.stand !== null);
              const desc = has
                ? RINGS.map((r) => `${labels[r]} ${d![r] !== null ? fmt.pct(d![r]!) : '–'}`).join(' · ')
                : t('consistency.rings.noDay');
              return (
                <Hint key={day} content={`${fmt.day(day, 'weekdayShort')}: ${desc}`}>
                  <div tabIndex={0} className="flex w-full flex-col items-center gap-0.5 rounded-md py-0.5 focus-visible:bg-surface-2" aria-label={`${fmt.day(day, 'weekdayShort')}: ${desc}`}>
                    <RingGlyph move={has ? d!.move : null} exercise={has ? d!.exercise : null} stand={has ? d!.stand : null} size={34} className={has ? '' : 'opacity-40'} />
                    <span className="text-[10px] leading-none tabular text-fg-3">{Number(day.slice(8))}</span>
                  </div>
                </Hint>
              );
            })}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <RingLegend labels={labels} />
            <div className="text-xs text-fg-3">
              {RINGS.map((r) => `${labels[r]} ${counts[r]}/${withRings.length}`).join(' · ')} ·{' '}
              {t('consistency.rings.perfectDays', { count: perfect })}
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
