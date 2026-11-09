import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, Download, Eye, EyeOff, ListChecks, MapPin, RotateCcw, Search, Shapes, Upload } from 'lucide-react';
import {
  sportInfo,
  workoutTitle,
  type ActivityListItem,
  type ActivityListQuery,
  type ActivitySort,
  type ActivityTotals,
} from '@cadence/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  FilterBar,
  IconButton,
  Input,
  Page,
  PageHeader,
  Select,
  Skeleton,
  Stat,
  Table,
  TD,
  TH,
  cn,
} from '@/components/ui';
import { PlaceText } from '@/components/map/PlaceText';
import { WorkoutTags } from '@/components/WorkoutTags';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { SportIcon, sportColorVar, sportLabel } from '@/lib/sports';
import { addDays, dayStartTs, startOfMonth, startOfWeek, startOfYear, todayKey } from '@/lib/time';
import { useActivityList, usePatchWorkout, useSportCounts } from '../api';
import { MedalBadge } from '../components/MedalBadge';
import { ToggleChip, chipClass } from '../components/ToggleChip';
import { SportDialog } from '../components/SportDialog';
import { StatList } from '../components/StatList';
import { keyStats, shortDistanceParts } from '../lib/display';

const RANGES = ['all', 'week', 'month', 'year', 'd30', 'd90', 'm12', 'custom'] as const;
type Range = (typeof RANGES)[number];
const SORTS: ActivitySort[] = ['start', 'distance', 'time', 'pace', 'elevation', 'hr', 'effort'];
const SIZES = ['25', '50', '100'] as const;
/** Sort choices of the card layout (narrow screens have no clickable column headers). */
const SORT_OPTIONS = [
  'start-desc',
  'start-asc',
  'distance-desc',
  'time-desc',
  'pace-desc',
  'elevation-desc',
  'hr-desc',
  'effort-desc',
] as const;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Filters, sorting and paging live in the URL (shareable, back button friendly). */
function useListParams() {
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const range = (RANGES as readonly string[]).includes(get('range')) ? (get('range') as Range) : 'all';
  const sort = (SORTS as string[]).includes(get('sort')) ? (get('sort') as ActivitySort) : 'start';
  const size = (SIZES as readonly string[]).includes(get('size')) ? Number(get('size')) : 25;
  const state = {
    sports: get('sport') ? get('sport').split(',').filter(Boolean) : [],
    range,
    fromDay: DAY_RE.test(get('from')) ? get('from') : '',
    toDay: DAY_RE.test(get('to')) ? get('to') : '',
    q: get('q'),
    gps: get('gps') === '1',
    hidden: get('hidden') === '1',
    sort,
    order: get('order') === 'asc' ? ('asc' as const) : ('desc' as const),
    page: Math.max(1, Number.parseInt(get('page'), 10) || 1),
    size,
  };
  /** Update some params; every change except paging goes back to page 1. */
  const update = (patch: Record<string, string | null>) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null || v === '') next.delete(k);
          else next.set(k, v);
        }
        if (!('page' in patch)) next.delete('page');
        return next;
      },
      { replace: true },
    );
  };
  return { state, update, reset: () => setParams(new URLSearchParams(), { replace: true }), active: params.toString() !== '' };
}

function rangeBounds(range: Range, fromDay: string, toDay: string, weekStart: 0 | 1): { from?: number; to?: number } {
  const today = todayKey();
  switch (range) {
    case 'week':
      return { from: dayStartTs(startOfWeek(today, weekStart)) };
    case 'month':
      return { from: dayStartTs(startOfMonth(today)) };
    case 'year':
      return { from: dayStartTs(startOfYear(today)) };
    case 'd30':
      return { from: dayStartTs(addDays(today, -29)) };
    case 'd90':
      return { from: dayStartTs(addDays(today, -89)) };
    case 'm12':
      return { from: dayStartTs(addDays(today, -364)) };
    case 'custom':
      return {
        from: fromDay ? dayStartTs(fromDay) : undefined,
        to: toDay ? dayStartTs(addDays(toDay, 1)) : undefined,
      };
    default:
      return {};
  }
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

function SearchBox({ value, onChange }: { value: string; onChange: (q: string) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const id = window.setTimeout(() => onChange(text.trim()), 300);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  return (
    <div className="relative w-full min-w-48 sm:w-64">
      <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" aria-hidden />
      <Input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('activities.list.search')}
        aria-label={t('common.search')}
        className="pl-8"
      />
    </div>
  );
}

function Totals({ totals, dim }: { totals: ActivityTotals; dim: boolean }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const d = fmt.distanceParts(totals.distanceM, 0);
  const e = fmt.elevationParts(totals.elevationM);
  return (
    <Card className={cn('mb-4 transition-opacity', dim && 'opacity-60')} aria-label={t('activities.list.totals')}>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat size="sm" label={t('activities.athlete.count')} value={fmt.int(totals.count)} />
        {totals.distanceM > 0 && <Stat size="sm" label={t('common.distance')} value={d.value} unit={d.unit} />}
        <Stat size="sm" label={t('common.movingTime')} value={fmt.num(totals.movingS / 3600, 1)} unit="h" />
        {totals.elevationM >= 1 && <Stat size="sm" label={t('common.elevationGain')} value={e.value} unit={e.unit} />}
        <Stat size="sm" label={t('common.calories')} value={fmt.compact(totals.energyKcal)} unit="kcal" />
        <Stat size="sm" label={t('common.effort')} value={fmt.int(totals.effort)} />
      </div>
    </Card>
  );
}

interface RowActions {
  onHide: (w: ActivityListItem) => void;
  onSport: (w: ActivityListItem) => void;
  busyId: number | null;
}

function Actions({ w, a }: { w: ActivityListItem; a: RowActions }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-end gap-0.5">
      <IconButton
        icon={w.hidden ? Eye : EyeOff}
        label={w.hidden ? t('activities.list.unhide') : t('activities.list.hide')}
        onClick={() => a.onHide(w)}
        disabled={a.busyId === w.id}
      />
      <IconButton icon={Shapes} label={t('activities.list.changeSport')} onClick={() => a.onSport(w)} />
    </div>
  );
}

function distanceText(w: ActivityListItem, fmt: ReturnType<typeof useFormat>): string {
  if (!w.distanceM || !sportInfo(w.sport).distance) return '–';
  if (w.sport === 'swim') {
    const p = shortDistanceParts(w.distanceM, fmt);
    return `${p.value} ${p.unit}`;
  }
  return fmt.distance(w.distanceM);
}

function ListTable({
  items,
  sort,
  order,
  onSort,
  actions,
}: {
  items: ActivityListItem[];
  sort: ActivitySort;
  order: 'asc' | 'desc';
  onSort: (s: ActivitySort) => void;
  actions: RowActions;
}) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const th = (key: ActivitySort | null, label: string, numeric = true, className?: string) => (
    <TH
      className={className}
      numeric={numeric}
      onClick={key ? () => onSort(key) : undefined}
      sorted={key && sort === key ? order : null}
    >
      {key ? (
        <span title={t('activities.list.sortBy', { column: label })}>{label}</span>
      ) : (
        label
      )}
    </TH>
  );
  return (
    <Table>
      <thead>
        <tr>
          {th('start', t('activities.list.columns.date'), false)}
          {th(null, t('activities.list.columns.title'), false)}
          {th('distance', t('activities.list.columns.distance'))}
          {th('time', t('activities.list.columns.time'))}
          {th('pace', t('activities.list.columns.pace'))}
          {th('elevation', t('activities.list.columns.elevation'), true, 'hidden xl:table-cell')}
          {th('hr', t('activities.list.columns.hr'), true, 'hidden xl:table-cell')}
          {th('effort', t('activities.list.columns.effort'))}
          <TH numeric>
            <span className="sr-only">{t('activities.list.columns.actions')}</span>
          </TH>
        </tr>
      </thead>
      <tbody>
        {items.map((w) => {
          const title = workoutTitle(w, lang);
          const info = sportInfo(w.sport);
          return (
            <tr key={w.id} className={cn('hover:bg-surface-2/60', w.hidden && 'opacity-60')}>
              <TD className="whitespace-nowrap">
                <div className="text-fg">{fmt.date(w.startTs, w.tzMin, 'dayShort')}</div>
                <div className="text-xs text-fg-3">
                  {fmt.date(w.startTs, w.tzMin, 'year')} · {fmt.time(w.startTs, w.tzMin)}
                </div>
              </TD>
              <TD className="w-full max-w-0 min-w-44">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="grid size-6 shrink-0 place-items-center rounded-full text-white"
                    style={{ background: sportColorVar(w.sport) }}
                    title={sportLabel(w.sport, lang)}
                  >
                    <SportIcon sport={w.sport} size={13} strokeWidth={2.25} />
                  </span>
                  <Link
                    to={`/activities/${w.id}`}
                    title={title}
                    className="truncate font-medium text-fg hover:text-accent-fg hover:underline"
                  >
                    {title}
                  </Link>
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden pl-7.5 text-xs text-fg-3">
                  <span className="shrink-0">{sportLabel(w.sport, lang)}</span>
                  {w.place && (
                    <>
                      <span aria-hidden>·</span>
                      <PlaceText w={w} size={11} />
                    </>
                  )}
                  {w.hidden && <Badge icon={EyeOff} className="shrink-0">{t('activities.list.hiddenBadge')}</Badge>}
                </div>
                <WorkoutTags w={w} className="mt-1 pl-7.5" />
                {/* medals in their own line, so the place is never squeezed to its icon */}
                {w.medals[0] && (
                  <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden pl-7.5">
                    <MedalBadge rank={w.medals[0].rank} effort={w.medals[0].effort} sport={w.sport} elapsedS={w.medals[0].elapsedS} />
                    {w.medals.length > 1 && <Badge>{t('activities.medal.more', { count: w.medals.length - 1 })}</Badge>}
                  </div>
                )}
              </TD>
              <TD numeric className="whitespace-nowrap">
                {distanceText(w, fmt)}
              </TD>
              <TD numeric className="whitespace-nowrap">
                {fmt.duration(w.movingS ?? w.durationS)}
              </TD>
              <TD numeric className="whitespace-nowrap">
                {info.speedMode !== 'none' && w.avgSpeed ? fmt.pace(w.avgSpeed, w.sport) : '–'}
              </TD>
              <TD numeric className="hidden whitespace-nowrap xl:table-cell">
                {w.hasRoute && w.elevationGainM !== null ? fmt.elevation(w.elevationGainM) : '–'}
              </TD>
              <TD numeric className="hidden xl:table-cell">
                {w.avgHr ? fmt.int(w.avgHr) : '–'}
              </TD>
              <TD numeric>
                {w.effort !== null ? (
                  <span title={w.effortEstimated ? t('common.estimated') : undefined}>
                    {fmt.int(w.effort)}
                    {w.effortEstimated && <span className="text-fg-3">*</span>}
                  </span>
                ) : (
                  '–'
                )}
              </TD>
              <TD numeric>
                <Actions w={w} a={actions} />
              </TD>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function ListCards({ items, actions }: { items: ActivityListItem[]; actions: RowActions }) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  return (
    <div className="grid gap-3">
      {items.map((w) => (
        <Card key={w.id} className={cn(w.hidden && 'opacity-60')}>
          <div className="flex items-start gap-3">
            <span
              className="grid size-9 shrink-0 place-items-center rounded-full text-white"
              style={{ background: sportColorVar(w.sport) }}
              title={sportLabel(w.sport, lang)}
            >
              <SportIcon sport={w.sport} size={17} strokeWidth={2.25} />
            </span>
            <div className="min-w-0 flex-1">
              <Link to={`/activities/${w.id}`} className="block truncate font-semibold text-fg hover:text-accent-fg">
                {workoutTitle(w, lang)}
              </Link>
              <div className="flex min-w-0 items-center gap-x-1 text-xs text-fg-3">
                <span className="shrink-0">
                  {fmt.date(w.startTs, w.tzMin, 'dateTime')} · {sportLabel(w.sport, lang)}
                </span>
                {w.place && (
                  <>
                    <span aria-hidden>·</span>
                    <PlaceText w={w} size={11} />
                  </>
                )}
              </div>
            </div>
            <Actions w={w} a={actions} />
          </div>
          <StatList items={keyStats(w, fmt, t, 4)} size="sm" className="mt-3" />
          <WorkoutTags w={w} className="mt-3" />
          {(w.medals.length > 0 || w.hidden) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {w.medals.slice(0, 3).map((m) => (
                <MedalBadge key={m.effort} rank={m.rank} effort={m.effort} sport={w.sport} elapsedS={m.elapsedS} />
              ))}
              {w.hidden && <Badge icon={EyeOff}>{t('activities.list.hiddenBadge')}</Badge>}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function Pagination({
  page,
  size,
  total,
  onPage,
  onSize,
}: {
  page: number;
  size: number;
  total: number;
  onPage: (p: number) => void;
  onSize: (s: string) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const pages = Math.max(1, Math.ceil(total / size));
  const from = total ? (page - 1) * size + 1 : 0;
  const to = Math.min(total, page * size);
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-fg-2">
      <span className="tabular">{t('activities.list.showing', { from: fmt.int(from), to: fmt.int(to), total: fmt.int(total) })}</span>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-fg-3">
          {t('activities.list.perPage')}
          <span className="w-20">
            <Select value={String(size)} onChange={onSize} options={SIZES.map((s) => ({ value: s, label: s }))} className="h-8" />
          </span>
        </label>
        <IconButton icon={ChevronLeft} label={t('activities.list.prev')} disabled={page <= 1} onClick={() => onPage(page - 1)} />
        <span className="tabular">
          {fmt.int(page)} / {fmt.int(pages)}
        </span>
        <IconButton icon={ChevronRight} label={t('activities.list.next')} disabled={page >= pages} onClick={() => onPage(page + 1)} />
      </div>
    </div>
  );
}

/** '/activities' — filterable, sortable list of every activity with totals and quick actions. */
export default function ActivitiesPage() {
  const { t, lang } = useI18n();
  const { settings } = useSettings();
  const { state: s, update, reset, active } = useListParams();
  const patch = usePatchWorkout();
  const [sportFor, setSportFor] = useState<{ id: number; sport: string; title: string } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const query = useMemo<ActivityListQuery>(() => {
    const b = rangeBounds(s.range, s.fromDay, s.toDay, settings.weekStart);
    return {
      sport: s.sports.join(',') || undefined,
      from: b.from,
      to: b.to,
      q: s.q || undefined,
      hasRoute: s.gps ? true : undefined,
      includeHidden: s.hidden || undefined,
      sort: s.sort,
      order: s.order,
      limit: s.size,
      offset: (s.page - 1) * s.size,
    };
  }, [s.sports, s.range, s.fromDay, s.toDay, s.q, s.gps, s.hidden, s.sort, s.order, s.size, s.page, settings.weekStart]);
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
            <SearchBox value={s.q} onChange={(q) => update({ q: q || null })} />
            <div className="w-52 lg:hidden">
              <Select
                value={`${s.sort}-${s.order}`}
                onChange={(v) => {
                  const [sort, order] = v.split('-') as [ActivitySort, 'asc' | 'desc'];
                  update({ sort: sort === 'start' ? null : sort, order: order === 'asc' ? 'asc' : null });
                }}
                options={SORT_OPTIONS.map((o) => ({ value: o, label: t(`activities.list.sortOptions.${o}`) }))}
                aria-label={t('activities.list.sort')}
              />
            </div>
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
              <Card padded={false} className="hidden overflow-hidden lg:block">
                <ListTable items={data.items} sort={s.sort} order={s.order} onSort={onSort} actions={actions} />
              </Card>
              <div className="lg:hidden">
                <ListCards items={data.items} actions={actions} />
              </div>
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
