import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Download, EyeOff, ListChecks, MapPin, RotateCcw, Upload } from 'lucide-react';
import { workoutTitle, type ActivityListQuery, type ActivitySort } from '@cadence/shared';
import { Button, Card, EmptyState, ErrorState, FilterBar, Input, Page, PageHeader, Select, Skeleton, cn } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { SportIcon, sportColorVar, sportLabel } from '@/lib/sports';
import { todayKey } from '@/lib/time';
import { listPageQuery, useActivityList, usePatchWorkout, useSportCounts } from '../api';
import { DebouncedSearch } from '../components/DebouncedSearch';
import { ListCards } from '../components/list/ListCards';
import { ListTable } from '../components/list/ListTable';
import { Pagination } from '../components/list/Pagination';
import type { RowActions } from '../components/list/RowActions';
import { Totals } from '../components/list/Totals';
import { ToggleChip, chipClass } from '../components/ToggleChip';
import { SportDialog } from '../components/SportDialog';
import {
  RANGES,
  SORT_OPTIONS,
  parseListParams,
  patchListParams,
  sortOption,
  sortPatch,
} from '../lib/listParams';
import { useMediaQuery } from '../lib/useMediaQuery';

/** Filters, sorting and paging live in the URL (shareable, back button friendly); see lib/listParams.ts. */
function useListParams() {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => parseListParams(params), [params]);
  /** Update some params; every change except paging goes back to page 1. */
  const update = (patch: Record<string, string | null>) =>
    setParams((prev) => patchListParams(prev, patch), { replace: true });
  return { state, update, reset: () => setParams(new URLSearchParams(), { replace: true }), active: params.toString() !== '' };
}

function SportChips({ selected, onChange }: { selected: string[]; onChange: (s: string[]) => void }) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const sports = useSportCounts();
  const chip = chipClass;
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('common.sport')}>
      <button className={chip(selected.length === 0)} aria-pressed={selected.length === 0} onClick={() => onChange([])}>
        {t('common.allSports')}
      </button>
      {(sports.data ?? []).map((s) => {
        const on = selected.includes(s.sport);
        return (
          <button
            key={s.sport}
            className={chip(on)}
            aria-pressed={on}
            onClick={() => onChange(on ? selected.filter((x) => x !== s.sport) : [...selected, s.sport])}
          >
            <span className="grid size-5 place-items-center rounded-full text-white" style={{ background: sportColorVar(s.sport) }}>
              <SportIcon sport={s.sport} size={12} strokeWidth={2.5} />
            </span>
            {sportLabel(s.sport, lang)}
            <span className="text-xs tabular text-fg-3">{fmt.int(s.count)}</span>
          </button>
        );
      })}
      {sports.isLoading && <Skeleton className="h-8 w-64 rounded-full" />}
    </div>
  );
}

/** '/activities' — filterable, sortable list of every activity with totals and quick actions. */
export default function ActivitiesPage() {
  const { t, lang } = useI18n();
  const { settings } = useSettings();
  const { state: s, update, reset: resetParams, active } = useListParams();
  const patch = usePatchWorkout();
  const [sportFor, setSportFor] = useState<{ id: number; sport: string; title: string } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  // one layout at a time: the table from Tailwind's lg up, the cards below
  const wide = useMediaQuery('(min-width: 64rem)');
  // a new search box on reset: a search typed just before must not come back with its pending commit
  const [searchKey, setSearchKey] = useState(0);
  const reset = () => {
    resetParams();
    setSearchKey((k) => k + 1);
  };

  // the period as local days: the server puts every activity on the day of its own time zone, not the browser's
  const query = useMemo<ActivityListQuery>(
    () => listPageQuery(s, settings.weekStart, todayKey()),
    [s, settings.weekStart],
  );
  const list = useActivityList(query);
  const data = list.data;
  // the same selection as a spreadsheet (all pages)
  const csvHref = useMemo(() => {
    const p = new URLSearchParams();
    const { limit: _limit, offset: _offset, ...filter } = query;
    for (const [k, v] of Object.entries({ ...filter, lang, units: settings.units }))
      if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
    return `/api/activities/export.csv?${p.toString()}`;
  }, [query, lang, settings.units]);
  const stale = list.isPlaceholderData;

  // a deep link past the last page (e.g. after hiding) snaps back to the last page
  useEffect(() => {
    if (data && !stale && data.total > 0 && data.items.length === 0 && s.page > 1)
      update({ page: String(Math.max(1, Math.ceil(data.total / s.size))) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, stale]);

  const actions: RowActions = {
    busyId,
    onHide: async (w) => {
      setBusyId(w.id);
      try {
        await patch.mutateAsync({ id: w.id, patch: { hidden: !w.hidden } });
      } finally {
        setBusyId(null);
      }
    },
    onSport: (w) => setSportFor({ id: w.id, sport: w.sport, title: workoutTitle(w, lang) }),
  };

  const onSort = (key: ActivitySort) => {
    if (key === s.sort) update({ order: s.order === 'desc' ? 'asc' : null });
    else update({ sort: key === 'start' ? null : key, order: null });
  };

  return (
    <Page wide>
      <PageHeader
        title={t('activities.titles.ActivitiesPage')}
        subtitle={t('activities.list.subtitle')}
        icon={ListChecks}
        actions={
          data && data.total > 0 ? (
            <a
              href={csvHref}
              download
              title={t('activities.list.exportCsvHint')}
              className="inline-flex h-8 items-center gap-1.5 rounded-control border border-border-strong bg-surface px-2.5 text-xs font-medium text-fg hover:bg-surface-2"
            >
              <Download size={14} aria-hidden />
              {t('activities.list.exportCsv')}
            </a>
          ) : undefined
        }
      >
        <div className="grid gap-3">
          <SportChips selected={s.sports} onChange={(sp) => update({ sport: sp.join(',') || null })} />
          <FilterBar>
            <div className="w-48">
              <Select
                value={s.range}
                onChange={(r) => update({ range: r === 'all' ? null : r, ...(r !== 'custom' ? { from: null, to: null } : {}) })}
                options={RANGES.map((r) => ({ value: r, label: t(`activities.list.ranges.${r}`) }))}
                aria-label={t('activities.list.range')}
              />
            </div>
            {s.range === 'custom' && (
              <>
                <div className="w-40">
                  <Input
                    type="date"
                    value={s.fromDay}
                    max={s.toDay || undefined}
                    onChange={(e) => update({ from: e.target.value || null })}
                    aria-label={t('activities.list.from')}
                  />
                </div>
                <div className="w-40">
                  <Input
                    type="date"
                    value={s.toDay}
                    min={s.fromDay || undefined}
                    onChange={(e) => update({ to: e.target.value || null })}
                    aria-label={t('activities.list.to')}
                  />
                </div>
              </>
            )}
            <DebouncedSearch
              key={searchKey}
              value={s.q}
              onChange={(q) => update({ q: q || null })}
              label={t('common.search')}
              placeholder={t('activities.list.search')}
              className="w-full min-w-48 sm:w-64"
            />
            {!wide && (
              <div className="w-52">
                <Select
                  value={sortOption(s.sort, s.order)}
                  onChange={(v) => update(sortPatch(v))}
                  options={SORT_OPTIONS.map((o) => ({ value: o, label: t(`activities.list.sortOptions.${o}`) }))}
                  aria-label={t('activities.list.sort')}
                />
              </div>
            )}
            <ToggleChip active={s.gps} onChange={(v) => update({ gps: v ? '1' : null })} icon={MapPin}>
              {t('activities.list.withGps')}
            </ToggleChip>
            <ToggleChip active={s.hidden} onChange={(v) => update({ hidden: v ? '1' : null })} icon={EyeOff}>
              {t('activities.list.showHidden')}
            </ToggleChip>
            {active && (
              <Button variant="ghost" size="sm" icon={RotateCcw} onClick={reset}>
                {t('activities.list.clear')}
              </Button>
            )}
          </FilterBar>
        </div>
      </PageHeader>

      {list.error && <ErrorState error={list.error} className="mb-4" />}
      {data ? (
        <>
          <Totals totals={data.totals} dim={stale} />
          {data.total === 0 ? (
            <Card>
              {active ? (
                <EmptyState
                  title={t('activities.list.noResults')}
                  description={t('activities.list.noResultsHint')}
                  action={
                    <Button icon={RotateCcw} onClick={reset}>
                      {t('activities.list.clear')}
                    </Button>
                  }
                />
              ) : (
                <EmptyState
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
              )}
            </Card>
          ) : (
            <div className={cn('transition-opacity', stale && 'opacity-60')}>
              {wide ? (
                <Card padded={false} className="overflow-hidden">
                  <ListTable items={data.items} sort={s.sort} order={s.order} onSort={onSort} actions={actions} />
                </Card>
              ) : (
                <ListCards items={data.items} actions={actions} />
              )}
              <Pagination
                page={s.page}
                size={s.size}
                total={data.total}
                onPage={(p) => update({ page: p > 1 ? String(p) : null })}
                onSize={(v) => update({ size: v === '25' ? null : v })}
              />
            </div>
          )}
        </>
      ) : (
        list.isLoading && (
          <>
            <Skeleton className="mb-4 h-20 w-full" />
            <Card padded={false} className="divide-y divide-border">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="flex items-center gap-4 px-4 py-3">
                  <Skeleton className="size-7 rounded-full" />
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-4 w-40" />
                </div>
              ))}
            </Card>
          </>
        )
      )}
      {patch.error && <ErrorState error={patch.error} className="mt-4" />}
      <SportDialog workout={sportFor} onClose={() => setSportFor(null)} />
    </Page>
  );
}
