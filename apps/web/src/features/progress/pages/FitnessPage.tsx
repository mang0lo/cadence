import { Gauge } from 'lucide-react';
import { Card, EmptyState, ErrorState, FilterBar, Page, PageHeader, SegmentedControl } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { useFitness, useOverview, usePhysiology } from '../api';
import { CardSkeleton, SportSelect } from '../components/common';
import { AcwrCard, DailyContextCard, FitnessStats, LoadCharts, RampCard, Vo2Card, WeeklyLoadCard } from '../components/fitness';
import { PERIOD_PRESETS } from '../periods';
import { useProgressFilters } from '../useFilters';
import { NoDataCard } from './ProgressPage';

export default function FitnessPage() {
  const t = useT();
  const overview = useOverview();
  // fitness counts every sport by default (a single sport can be picked)
  const f = useProgressFilters(overview.data, { sport: 'all', period: '6m' });
  const fitness = useFitness(f.sport, f.range);
  const physiology = usePhysiology(f.range);
  const data = fitness.data;

  return (
    <Page>
      <PageHeader title={t('progress.titles.FitnessPage')} subtitle={t('progress.fitness.subtitle')} icon={Gauge}>
        <FilterBar>
          <SportSelect value={f.sport} onChange={f.setSport} sports={overview.data?.sports ?? []} />
          <SegmentedControl
            value={f.period}
            onChange={f.setPeriod}
            label={t('progress.filters.period')}
            items={PERIOD_PRESETS.map((p) => ({ value: p, label: t(`progress.filters.periods.${p}`) }))}
          />
          {f.sport === 'all' && <span className="text-xs text-fg-3">{t('progress.fitness.sportHint')}</span>}
        </FilterBar>
      </PageHeader>
      {overview.error || fitness.error ? (
        <ErrorState error={overview.error ?? fitness.error} />
      ) : overview.data && !overview.data.sports.length ? (
        <NoDataCard />
      ) : !data ? (
        <div className="grid gap-4">
          <CardSkeleton title={t('progress.fitness.stats.fitness')} height={96} />
          <CardSkeleton title={t('progress.fitness.charts.load')} height={260} />
          <CardSkeleton title={t('progress.fitness.charts.form')} height={240} />
        </div>
      ) : !data.days.length ? (
        <Card>
          <EmptyState icon={Gauge} title={t('progress.fitness.empty')} description={t('progress.fitness.emptyHint')} />
        </Card>
      ) : (
        <div className="grid gap-4">
          <FitnessStats data={data} />
          <LoadCharts data={data} loading={fitness.isFetching} />
          <div className="grid gap-4 xl:grid-cols-3">
            <WeeklyLoadCard data={data} loading={fitness.isFetching} />
            <AcwrCard data={data} loading={fitness.isFetching} />
            <RampCard data={data} loading={fitness.isFetching} />
          </div>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Vo2Card data={physiology.data} loading={physiology.isFetching} error={physiology.error} />
            <div className="grid min-w-0 gap-4">
              <DailyContextCard kind="restingHr" series={physiology.data?.restingHr} loading={physiology.isFetching} />
              <DailyContextCard kind="hrv" series={physiology.data?.hrv} loading={physiology.isFetching} />
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}
