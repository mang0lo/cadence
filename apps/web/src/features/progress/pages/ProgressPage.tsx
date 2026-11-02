import { Link } from 'react-router';
import { TrendingUp, Upload } from 'lucide-react';
import { PROGRESS_VOLUME_METRICS, sportInfo } from '@cadence/shared';
import { Button, Card, EmptyState, ErrorState, FilterBar, Page, PageHeader, SegmentedControl } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { useOverview } from '../api';
import { CardSkeleton, SportSelect } from '../components/common';
import { CompareCard } from '../components/CompareCard';
import { IntensityCard } from '../components/IntensityCard';
import { PaceAtHrCard } from '../components/PaceAtHrCard';
import { TrendsCard } from '../components/TrendsCard';
import { VolumeCard } from '../components/VolumeCard';
import { YoyCard } from '../components/YoyCard';
import { PERIOD_PRESETS } from '../periods';
import { useProgressFilters } from '../useFilters';

export function NoDataCard() {
  const t = useT();
  return (
    <Card>
      <EmptyState
        icon={Upload}
        title={t('common.noData')}
        description={t('common.noDataHint')}
        action={
          <Link to="/import">
            <Button variant="primary">{t('common.importNow')}</Button>
          </Link>
        }
      />
    </Card>
  );
}

export default function ProgressPage() {
  const t = useT();
  const overview = useOverview();
  const f = useProgressFilters(overview.data);
  const sports = overview.data?.sports ?? [];
  const metrics = PROGRESS_VOLUME_METRICS.filter((m) => f.hasDistance || (m !== 'distance' && m !== 'elevation'));
  const distanceSports = sports.filter((s) => sportInfo(s.sport).distance).map((s) => s.sport);

  return (
    <Page>
      <PageHeader title={t('progress.titles.ProgressPage')} subtitle={t('progress.page.subtitle')} icon={TrendingUp}>
        <FilterBar>
          <SportSelect value={f.sport} onChange={f.setSport} sports={sports} />
          <SegmentedControl
            value={f.period}
            onChange={f.setPeriod}
            label={t('progress.filters.period')}
            items={PERIOD_PRESETS.map((p) => ({ value: p, label: t(`progress.filters.periods.${p}`) }))}
          />
          <SegmentedControl
            value={f.metric}
            onChange={f.setMetric}
            label={t('progress.filters.metric')}
            items={metrics.map((m) => ({ value: m, label: t(`progress.filters.metrics.${m}`) }))}
          />
        </FilterBar>
      </PageHeader>
      {overview.error ? (
        <ErrorState error={overview.error} />
      ) : overview.data && !sports.length ? (
        <NoDataCard />
      ) : !overview.data ? (
        <div className="grid gap-4">
          <CardSkeleton title={t('progress.volume.title')} height={300} />
          <div className="grid gap-4 xl:grid-cols-2">
            <CardSkeleton title={t('progress.yoy.title')} height={308} />
            <CardSkeleton title={t('progress.compare.title')} height={308} />
          </div>
        </div>
      ) : (
        <div className="grid gap-4">
          <VolumeCard sport={f.sport} metric={f.metric} range={f.range} />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <YoyCard sport={f.sport} metric={f.metric} />
            <CompareCard sport={f.sport} />
          </div>
          <TrendsCard sport={f.sport} range={f.range} sportsWithData={distanceSports} onPickSport={f.setSport} />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <PaceAtHrCard sport={f.sport} range={f.range} />
            <IntensityCard sport={f.sport} range={f.range} />
          </div>
        </div>
      )}
    </Page>
  );
}
