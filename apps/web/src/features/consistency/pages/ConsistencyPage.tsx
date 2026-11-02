import { useState } from 'react';
import { CalendarCheck } from 'lucide-react';
import { Card, ErrorState, FilterBar, Page, PageHeader, Skeleton } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { useCalendar, useOverview } from '../api';
import { AsOfNote, NoActivities } from '../components/AsOfNote';
import { CalendarCard } from '../components/CalendarCard';
import { DayPanel } from '../components/DayPanel';
import { MonthlyActiveDays, RingClosureCard } from '../components/MonthlyCharts';
import { PunchcardCard } from '../components/Punchcard';
import { RingHistoryCard } from '../components/RingHistory';
import { ScoreCard, ScoreTrendCard } from '../components/Score';
import { StreakCards, StreakCardsSkeleton } from '../components/StreakCards';
import { YearSwitcher } from '../components/YearSwitcher';

export default function ConsistencyPage() {
  const t = useT();
  const { settings } = useSettings();
  const overview = useOverview();
  const o = overview.data;
  const [yearSel, setYearSel] = useState<number | null>(null);
  const year = yearSel ?? (o ? Number(o.asOf.slice(0, 4)) : new Date().getFullYear());
  const cal = useCalendar(o ? { year } : null);
  const calPrev = useCalendar(o ? { year: year - 1 } : null);
  const [selected, setSelected] = useState<string | null>(null);
  const weekStart = settings.weekStart;
  // while another year loads, the previous year's render stays (dimmed) instead of a skeleton
  const shownYear = cal.data ? Number(cal.data.from.slice(0, 4)) : year;
  const prevData = calPrev.data?.from.startsWith(String(shownYear - 1)) ? calPrev.data : undefined;

  const header = (
    <PageHeader title={t('consistency.page.title')} subtitle={t('consistency.page.subtitle')} icon={CalendarCheck} />
  );

  if (overview.error)
    return (
      <Page>
        {header}
        <ErrorState error={overview.error} />
      </Page>
    );

  if (!o)
    return (
      <Page>
        {header}
        <div className="space-y-4">
          <StreakCardsSkeleton />
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <Skeleton className="h-80 rounded-card" />
            <Skeleton className="h-80 rounded-card" />
          </div>
          <Skeleton className="h-64 rounded-card" />
        </div>
      </Page>
    );

  if (!o.firstDay)
    return (
      <Page>
        {header}
        <Card>
          <NoActivities />
        </Card>
      </Page>
    );

  return (
    <Page>
      {header}
      <div className="space-y-4">
        <AsOfNote asOf={o.asOf} today={o.today} />
        <StreakCards data={o} />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <ScoreCard score={o.score} prefs={o.prefs} />
          <ScoreTrendCard score={o.score} />
        </div>

        <section aria-labelledby="consistency-year" className="space-y-4 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="consistency-year" className="text-lg font-semibold tracking-tight text-fg">
              {t('consistency.page.yearSection', { year })}
            </h2>
            <FilterBar>
              <YearSwitcher
                year={year}
                years={o.years}
                onChange={(y) => {
                  setYearSel(y);
                  setSelected(null);
                }}
              />
            </FilterBar>
          </div>
          {cal.error && <ErrorState error={cal.error} />}
          <CalendarCard
            year={shownYear}
            asOf={o.asOf}
            weekStart={weekStart}
            data={cal.data}
            loading={cal.isFetching}
            selectedDay={selected}
            onSelectDay={(d) => setSelected((cur) => (cur === d ? null : d))}
          />
          {selected && <DayPanel day={selected} onClose={() => setSelected(null)} />}
          <div className="grid gap-4 lg:grid-cols-2">
            <MonthlyActiveDays year={shownYear} asOf={o.asOf} cur={cal.data} prev={prevData} loading={cal.isFetching} />
            <PunchcardCard year={year} weekStart={weekStart} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <RingHistoryCard year={shownYear} weekStart={weekStart} data={cal.data} />
            <RingClosureCard year={shownYear} data={cal.data} loading={cal.isFetching} />
          </div>
        </section>
      </div>
    </Page>
  );
}
