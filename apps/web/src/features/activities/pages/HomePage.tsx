import { use } from 'react';
import { Link } from 'react-router';
import { Activity, Upload } from 'lucide-react';
import { Button, Card, EmptyState, ErrorState, Page } from '@/components/ui';
import { dashboardWidgetsFor, loadedWidgets, loadWidgets } from '@/features/registry';
import { useT } from '@/lib/i18n';
import { useDataSources } from '@/lib/sources';
import { useActivitiesSummary, useFeed } from '../api';
import { AthleteCard, AthleteCardSkeleton } from '../components/AthleteCard';
import { FeedCard, FeedCardSkeleton } from '../components/FeedCard';
import { WidgetBoundary } from '../components/WidgetBoundary';

/**
 * The features' dashboard widgets in their order. Each renders its own Card (or null). Their code is loaded already: the
 * route loads it together with this page (withDashboardWidgets in the registry).
 */
function Widgets() {
  const t = useT();
  const sources = useDataSources().data;
  const components = loadedWidgets() ?? use(loadWidgets());
  return (
    // minmax(0,1fr): an `auto` track would grow with the widest widget and overflow the side column
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      {dashboardWidgetsFor(sources).map((w) => {
        const W = components.get(w.id)!;
        return (
          <WidgetBoundary key={w.id} fallback={<ErrorState error={t('activities.widgets.error')} />}>
            <W />
          </WidgetBoundary>
        );
      })}
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
  // only without any loaded page: a failed "load more" or background refetch keeps the cards (TanStack keeps the pages)
  if (feed.error && !feed.data) return <ErrorState error={feed.error} />;
  const items = feed.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="grid gap-4">
      {items.map((w) => (
        <FeedCard key={w.id} w={w} />
      ))}
      {feed.error && <ErrorState error={feed.error} />}
      <div className="flex justify-center py-2">
        {feed.hasNextPage ? (
          <Button onClick={() => void feed.fetchNextPage()} loading={feed.isFetchingNextPage}>
            {feed.isFetchNextPageError ? t('common.retry') : t('activities.feed.loadMore')}
          </Button>
        ) : feed.error ? (
          <Button onClick={() => void feed.refetch()} loading={feed.isRefetching}>
            {t('common.retry')}
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
