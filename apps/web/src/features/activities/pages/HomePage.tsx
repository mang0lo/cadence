import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Activity, Upload } from 'lucide-react';
import { Button, Card, EmptyState, ErrorState, Page } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { CalendarWidget, GoalsWidget, StreakWidget } from '../../consistency/widgets';
import { HealthSnapshotWidget } from '../../health/widgets';
import { ExplorerWidget } from '../../maps/widgets';
import { FitnessWidget, WeeklySnapshotWidget } from '../../progress/widgets';
import { useActivitiesSummary, useFeed } from '../api';
import { AthleteCard, AthleteCardSkeleton } from '../components/AthleteCard';
import { FeedCard, FeedCardSkeleton } from '../components/FeedCard';
import { WidgetBoundary } from '../components/WidgetBoundary';

/** Other features' dashboard widgets, in the agreed order. Each renders its own Card (or null). */
const WIDGETS: [string, () => ReactNode][] = [
  ['weekly-snapshot', WeeklySnapshotWidget],
  ['fitness', FitnessWidget],
  ['streak', StreakWidget],
  ['goals', GoalsWidget],
  ['calendar', CalendarWidget],
  ['health', HealthSnapshotWidget],
  ['explorer', ExplorerWidget],
];

function Widgets() {
  const t = useT();
  return (
    <div className="grid min-w-0 gap-4">
      {WIDGETS.map(([key, W]) => (
        <WidgetBoundary key={key} fallback={<ErrorState error={t('activities.widgets.error')} />}>
          <W />
        </WidgetBoundary>
      ))}
    </div>
  );
}

function Feed() {
  const t = useT();
  const feed = useFeed();
  if (feed.isLoading)
    return (
      <div className="grid gap-4">
        <FeedCardSkeleton />
        <FeedCardSkeleton />
        <FeedCardSkeleton />
      </div>
    );
  if (feed.error) return <ErrorState error={feed.error} />;
  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="grid gap-4">
      {items.map((w) => (
        <FeedCard key={w.id} w={w} />
      ))}
      <div className="flex justify-center py-2">
        {feed.hasNextPage ? (
          <Button onClick={() => void feed.fetchNextPage()} loading={feed.isFetchingNextPage}>
            {t('activities.feed.loadMore')}
          </Button>
        ) : (
          items.length > 0 && <span className="text-xs text-fg-3">{t('activities.feed.allLoaded')}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Dashboard ('/'): athlete card, activity feed and the other features' widgets.
 * Narrow: stacked. lg: feed + side column. ≥ 85rem (1360 px): three columns (athlete · feed · widgets).
 */
export default function HomePage() {
  const t = useT();
  const summary = useActivitiesSummary();
  const empty = summary.data && summary.data.allTime.count === 0;
  return (
    <Page wide>
      <h1 className="sr-only">{t('activities.titles.HomePage')}</h1>
      {summary.error && <ErrorState error={summary.error} className="mb-4" />}
      {empty ? (
        <Card>
          <EmptyState
            icon={Activity}
            title={t('activities.feed.emptyTitle')}
            description={t('activities.feed.emptyHint')}
            action={
              <Link to="/import">
                <Button variant="primary" icon={Upload}>
                  {t('common.importNow')}
                </Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px] lg:grid-rows-[auto_1fr] min-[85rem]:grid-cols-[272px_minmax(0,1fr)_300px] min-[85rem]:grid-rows-[auto]">
          <div className="min-w-0 lg:col-start-2 lg:row-start-1 min-[85rem]:col-start-1">
            {summary.data ? <AthleteCard summary={summary.data} /> : summary.isLoading ? <AthleteCardSkeleton /> : null}
          </div>
          <section className="min-w-0 lg:col-start-1 lg:row-span-2 lg:row-start-1 min-[85rem]:col-start-2 min-[85rem]:row-span-1">
            <h2 className="sr-only">{t('activities.feed.title')}</h2>
            <Feed />
          </section>
          <aside className="min-w-0 lg:col-start-2 lg:row-start-2 min-[85rem]:col-start-3 min-[85rem]:row-start-1">
            <Widgets />
          </aside>
        </div>
      )}
    </Page>
  );
}
