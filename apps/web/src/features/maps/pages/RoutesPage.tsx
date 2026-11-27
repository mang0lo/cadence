import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Route as RouteIcon } from 'lucide-react';
import type { MapsRouteSummary, MapsRoutesResponse } from '@cadence/shared';
import { RouteThumbnail } from '@/components/map/RouteThumbnail';
import {
  Button,
  Card,
  Delta,
  EmptyState,
  ErrorState,
  FilterBar,
  Page,
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
  cn,
} from '@/components/ui';
import { useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useI18n, useT } from '@/lib/i18n';
import { SportIcon, sortSports, sportColorVar, useSportLabel } from '@/lib/sports';
import { useStoredState } from '@/lib/storage';
import { TrendSparkline } from '../components/TrendSparkline';
import { activeRouteSport, kindLabel, routeTitle, trendChange } from '../lib/routeName';

type SortKey = 'count' | 'recent' | 'distance' | 'improved';
const PAGE_SIZE = 48;

function sortRoutes(items: MapsRouteSummary[], sort: SortKey): MapsRouteSummary[] {
  const list = [...items];
  switch (sort) {
    case 'recent':
      return list.sort((a, b) => b.lastTs - a.lastTs);
    case 'distance':
      return list.sort((a, b) => b.distanceM - a.distanceM);
    case 'improved':
      return list.sort((a, b) => (trendChange(b.trend) ?? -9) - (trendChange(a.trend) ?? -9));
    default:
      return list.sort((a, b) => b.count - a.count || b.lastTs - a.lastTs);
  }
}

export default function RoutesPage() {
  const t = useT();
  const sportLabel = useSportLabel();
  const [picked, setSport] = useState<string>('all');
  const [min, setMin] = useStoredState<'2' | '3' | '5'>('maps.routes.min', '2');
  const [sort, setSort] = useStoredState<SortKey>('maps.routes.sort', 'count');
  const [shown, setShown] = useState(PAGE_SIZE);

  const q = useApi<MapsRoutesResponse>(['maps', 'routes'], '/maps/routes', { min: Number(min) });
  const data = q.data;
  const sports = useMemo(() => sortSports((data?.sports ?? []).map((s) => s.sport)), [data]);
  // the sport counts follow the minimum: a sport without routes at a higher minimum stops filtering
  const sport = activeRouteSport(picked, sports);
  const items = useMemo(() => {
    const list = (data?.items ?? []).filter((r) => sport === 'all' || r.sport === sport);
    return sortRoutes(list, sort);
  }, [data, sport, sort]);

  return (
    <Page>
      <PageHeader icon={RouteIcon} title={t('maps.titles.RoutesPage')} subtitle={t('maps.routes.subtitle')}>
        <FilterBar className="gap-x-3 gap-y-2">
          {sports.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('common.sport')}>
              <Chip active={sport === 'all'} onClick={() => setSport('all')}>
                {t('common.allSports')}
              </Chip>
              {sports.map((s) => (
                <Chip key={s} active={sport === s} onClick={() => setSport(s)}>
                  <span style={{ color: sportColorVar(s) }}>
                    <SportIcon sport={s} size={13} strokeWidth={2.5} />
                  </span>
                  {sportLabel(s)}
                </Chip>
              ))}
            </div>
          )}
          <SegmentedControl
            label={t('maps.routes.minTimes')}
            value={min}
            onChange={(v) => {
              setMin(v);
              setShown(PAGE_SIZE);
            }}
            items={[
              { value: '2', label: '2×+' },
              { value: '3', label: '3×+' },
              { value: '5', label: '5×+' },
            ]}
          />
          <div className="w-44 [&>select]:w-full">
            <Select
              value={sort}
              onChange={setSort}
              aria-label={t('maps.routes.sortBy')}
              options={(['count', 'recent', 'distance', 'improved'] as const).map((k) => ({
                value: k,
                label: t(`maps.routes.sort.${k}`),
              }))}
            />
          </div>
        </FilterBar>
      </PageHeader>

      {q.isError && <ErrorState error={q.error} />}

      {!data && !q.isError && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-64 rounded-card" />
          ))}
        </div>
      )}

      {data && items.length === 0 && (
        <Card>
          {min === '2' ? (
            <EmptyState
              icon={RouteIcon}
              title={t('maps.routes.empty')}
              description={t('maps.routes.emptyHint')}
            />
          ) : (
            <EmptyState
              icon={RouteIcon}
              title={t('maps.routes.noneAtMin', { min })}
              action={
                <Button
                  onClick={() => {
                    setMin('2');
                    setShown(PAGE_SIZE);
                  }}
                >
                  {t('maps.routes.showFromTwice')}
                </Button>
              }
            />
          )}
        </Card>
      )}

      {items.length > 0 && (
        <>
          <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,19rem),1fr))]">
            {items.slice(0, shown).map((r) => (
              <li key={r.id} className="min-w-0">
                <RouteCard route={r} />
              </li>
            ))}
          </ul>
          {items.length > shown && (
            <div className="mt-5 flex justify-center">
              <Button onClick={() => setShown((n) => n + PAGE_SIZE)}>
                {t('maps.routes.showMore', { count: items.length - shown })}
              </Button>
            </div>
          )}
        </>
      )}
    </Page>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition-colors',
        active
          ? 'border-accent/50 bg-accent-soft text-accent-fg'
          : 'border-border bg-surface text-fg-2 hover:bg-surface-2 hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

function RouteCard({ route: r }: { route: MapsRouteSummary }) {
  const t = useT();
  const fmt = useFormat();
  const { lang } = useI18n();
  const sportLabel = useSportLabel();
  const change = trendChange(r.trend);
  return (
    <Link
      to={`/maps/routes/${r.id}`}
      className="group flex h-full flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card transition-colors hover:border-border-strong"
    >
      <RouteThumbnail
        polyline={r.polyline}
        color={sportColorVar(r.sport)}
        width={320}
        height={150}
        className="h-36 w-full rounded-none"
        ariaLabel={routeTitle(r, t, fmt, lang)}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-fg group-hover:text-accent-fg">
            {routeTitle(r, t, fmt, lang)}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
            <span className="inline-flex items-center gap-1" style={{ color: sportColorVar(r.sport) }}>
              <SportIcon sport={r.sport} size={13} strokeWidth={2.5} />
            </span>
            <span>{sportLabel(r.sport)}</span>
            <span aria-hidden>·</span>
            <span>{kindLabel(r.kind, t)}</span>
            {r.customName && (
              <>
                <span aria-hidden>·</span>
                <span className="tabular">{fmt.distance(r.distanceM, 1)}</span>
              </>
            )}
          </div>
        </div>
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-end gap-x-4 gap-y-1">
          <div className="min-w-0">
            <div className="text-xs text-fg-3">{t('maps.routes.timesDone')}</div>
            <div className="text-xl font-semibold tracking-tight text-fg tabular">{fmt.int(r.count)}×</div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-2 text-xs text-fg-3">
              <span>{t('maps.routes.trend')}</span>
              {change !== null && Math.abs(change) >= 0.005 && (
                <Delta
                  value={change}
                  text={fmt.signed(change * 100, Math.abs(change) < 0.1 ? 1 : 0) + ' %'}
                />
              )}
            </div>
            <TrendSparkline
              data={r.trend}
              height={30}
              ariaLabel={t('maps.routes.trend')}
              className="mr-1.5"
            />
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-border pt-3 text-xs">
          <Stat3 label={t('maps.routes.best')} value={fmt.duration(r.bestTimeS)} />
          <Stat3
            label={t('maps.routes.latest')}
            value={fmt.duration(r.latestTimeS)}
            hint={fmt.dateHint(r.lastTs, r.lastTzMin)}
          />
        </dl>
      </div>
    </Link>
  );
}

function Stat3({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-fg-3">{label}</dt>
      <dd className="font-semibold text-fg tabular">
        {value}
        {hint && <span className="ml-1.5 font-normal text-fg-3">{hint}</span>}
      </dd>
    </div>
  );
}
