import { Medal } from 'lucide-react';
import { ErrorState, FilterBar, Page, PageHeader, SegmentedControl } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { useEffortHistory, usePredictions, useRecords } from '../api';
import { CardSkeleton, SportSelect } from '../components/common';
import { EffortsCard, HighlightsCard, PredictorCard, ProgressionCard, TopTenCard, type RecordScope } from '../components/records';
import { urlSport, useUrlParams } from '../useFilters';
import { NoDataCard } from './ProgressPage';

const SCOPES: RecordScope[] = ['allTime', 'thisYear', 'last12m'];

export default function RecordsPage() {
  const t = useT();
  const [params, set] = useUrlParams();
  // an unknown ?sport= (old link) is dropped: the server's default sport applies and the picker stays usable
  const asked = urlSport(params.get('sport'));
  const records = useRecords(asked);
  const data = records.data;
  const sport = data?.sport ?? asked;
  const rawScope = params.get('scope') as RecordScope | null;
  const scope: RecordScope = rawScope && SCOPES.includes(rawScope) ? rawScope : 'allTime';
  const withAttempts = data?.efforts.filter((e) => e.attempts > 0) ?? [];
  const rawEffort = params.get('effort');
  const effort =
    rawEffort && withAttempts.some((e) => e.effort === rawEffort)
      ? rawEffort
      : (withAttempts.find((e) => e.effort === '5k')?.effort ?? withAttempts[0]?.effort ?? null);
  const history = useEffortHistory(sport, effort);
  const isRun = sport === 'run';
  const predictions = usePredictions(isRun);

  return (
    <Page>
      <PageHeader title={t('progress.titles.RecordsPage')} subtitle={t('progress.records.subtitle')} icon={Medal}>
        <FilterBar>
          <SportSelect
            value={sport ?? ''}
            allowAll={false}
            onChange={(s) => set({ sport: s, effort: null })}
            sports={data?.sports ?? []}
          />
          <SegmentedControl
            value={scope}
            onChange={(s) => set({ scope: s })}
            label={t('progress.filters.period')}
            items={SCOPES.map((s) => ({ value: s, label: t(`progress.records.scope.${s}`) }))}
          />
        </FilterBar>
      </PageHeader>
      {records.error ? (
        <ErrorState error={records.error} />
      ) : !data ? (
        <div className="grid gap-4">
          <CardSkeleton title={t('progress.records.highlights.title')} height={120} />
          <CardSkeleton title={t('progress.records.table.title')} height={360} />
        </div>
      ) : !data.sport ? (
        <NoDataCard />
      ) : (
        <div className="grid gap-4">
          <HighlightsCard sport={data.sport} highlights={data.scopeHighlights[scope]} scope={scope} />
          {data.efforts.length > 0 && (
            <>
              <div className={isRun ? 'grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]' : 'grid gap-4'}>
                <EffortsCard
                  sport={data.sport}
                  efforts={data.efforts}
                  scope={scope}
                  selected={effort}
                  onSelect={(e) => set({ effort: e })}
                />
                {isRun && <PredictorCard data={predictions.data} error={predictions.error} />}
              </div>
              {withAttempts.length > 0 && (
                <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                  <ProgressionCard
                    sport={data.sport}
                    effort={effort}
                    history={history.data}
                    loading={history.isFetching}
                    error={history.error}
                  />
                  <TopTenCard sport={data.sport} effort={effort} history={history.data} scope={scope} error={history.error} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Page>
  );
}
