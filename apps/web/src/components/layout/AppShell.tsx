import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigation, useNavigationType } from 'react-router';
import { ArrowUpDown, ChevronDown, ChevronUp, GripVertical, Menu, Moon, Sparkles, Sun, Watch, X } from 'lucide-react';
import { featureModules } from '@/features/registry';
import type { NavGroup, NavItem } from '@/features/types';
import { useImportJobs } from '@/features/platform/useImportJobs';
import { jobPhaseLabel, jobStepLabel } from '@/features/platform/importJobs';
import {
  latestSummaryJob,
  markSummarySeen,
  summaryCounts,
  useSeenSummaryId,
} from '@/features/platform/whatsNewState';
import { cn, ProgressBar } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { useDataSources } from '@/lib/sources';
import { useResolvedTheme } from '@/lib/theme';
import { Logo } from './Logo';
import { mergeShown, moved, orderNav, type NavPrefs } from './navOrder';

const GROUPS: NavGroup[] = ['training', 'habits', 'explore', 'health', 'app'];
const ALL_ITEMS: NavItem[] = featureModules.flatMap((f) => f.nav);

interface Nav {
  /** The groups and pages shown, in the athlete's order. */
  shown: { group: NavGroup; items: NavItem[] }[];
  /** Every group with every page (also the ones hidden for this athlete), in the athlete's order. */
  all: { group: NavGroup; items: NavItem[] }[];
}

function useNav(prefs: NavPrefs): Nav {
  const sources = useDataSources().data;
  return useMemo(() => {
    const all = orderNav(ALL_ITEMS, GROUPS, prefs) as Nav['all'];
    // pages that cannot have data for this athlete (ECG, body …) are left out once the data sources are known
    const visible = ALL_ITEMS.filter((it) => !it.available || !sources || it.available(sources));
    // An item whose path prefixes another item must match exactly, else both would be active.
    const withEnd = visible.map((it) => ({
      ...it,
      end: it.end || it.path === '/' || visible.some((o) => o !== it && o.path.startsWith(`${it.path}/`)),
    }));
    return { all, shown: orderNav(withEnd, GROUPS, prefs) as Nav['shown'] };
  }, [sources, prefs]);
}

/** The saved order after moving a page inside its group (positions among the pages shown). */
function withItemMoved(nav: Nav, group: NavGroup, from: number, to: number): NavPrefs {
  const shown = nav.shown.find((g) => g.group === group)!.items.map((i) => i.path);
  const next = moved(shown, from, to);
  return {
    groups: nav.all.map((g) => g.group),
    order: nav.all.flatMap((g) => {
      const paths = g.items.map((i) => i.path);
      return g.group === group ? mergeShown(paths, next) : paths;
    }),
  };
}

/** The saved order after moving a group (positions among the groups shown). */
function withGroupMoved(nav: Nav, from: number, to: number): NavPrefs {
  const next = moved(
    nav.shown.map((g) => g.group),
    from,
    to,
  );
  return {
    groups: mergeShown(
      nav.all.map((g) => g.group),
      next,
    ),
    order: nav.all.flatMap((g) => g.items.map((i) => i.path)),
  };
}

function NavEntry({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const t = useT();
  const Icon = item.icon;
  return (
    <NavLink
      to={item.path}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'group relative flex items-center gap-2.5 rounded-control px-2.5 py-1.5 text-sm font-medium transition-colors',
          isActive ? 'bg-accent-soft text-fg' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-accent" />}
          <Icon size={17} className={isActive ? 'text-accent-fg' : 'text-fg-3 group-hover:text-fg-2'} />
          <span className="truncate">{t(item.labelKey)}</span>
        </>
      )}
    </NavLink>
  );
}

/** Finished import with news the user has not looked at yet (from the last 3 days). */
function WhatsNewNote() {
  const t = useT();
  const fmt = useFormat();
  const { jobs } = useImportJobs();
  const seen = useSeenSummaryId();
  const job = latestSummaryJob(jobs);
  if (!job || job.id === seen || job.stats.summary.count === 0) return null;
  if (!job.finishedAt || Date.now() / 1000 - job.finishedAt > 3 * 86_400) return null;
  const s = job.stats.summary;
  const c = summaryCounts(s);
  const parts = [
    t(s.initial ? 'platform.whatsNew.initial' : 'platform.whatsNew.activities', {
      count: s.count,
      n: fmt.int(s.count),
    }),
    c.records ? t('platform.whatsNew.records', { count: c.records }) : null,
    c.trophies ? t('platform.whatsNew.trophies', { count: c.trophies }) : null,
  ].filter(Boolean);
  return (
    <div className="relative rounded-control border border-border bg-surface-2 p-2.5 pr-8 text-xs">
      <Link to="/import" className="block">
        <div className="mb-0.5 flex items-center gap-1.5 font-medium text-fg">
          <Sparkles size={13} className="text-accent-fg" aria-hidden />
          {t('platform.whatsNew.done')}
        </div>
        <div className="text-fg-2">{parts.join(' · ')}</div>
        <div className="mt-1 font-medium text-accent-fg">{t('platform.whatsNew.show')}</div>
      </Link>
      <button
        type="button"
        onClick={() => markSummarySeen(job.id)}
        className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-control text-fg-3 hover:bg-surface-3 hover:text-fg"
        aria-label={t('platform.whatsNew.dismiss')}
        title={t('platform.whatsNew.dismiss')}
      >
        <X size={13} aria-hidden />
      </button>
    </div>
  );
}

function ImportIndicator() {
  const t = useT();
  const fmt = useFormat();
  // the job the server works on (not the newest queued one); its English message is not shown
  const { current } = useImportJobs();
  if (!current) return <WhatsNewNote />;
  return (
    <Link to="/import" className="block rounded-control border border-border bg-surface-2 p-2.5 text-xs">
      <div className="mb-1.5 flex items-center justify-between font-medium text-fg">
        <span>{t('common.importRunning')}</span>
        <span className="tabular text-fg-3">{fmt.pct(current.progress)}</span>
      </div>
      <ProgressBar value={current.progress} height={5} />
      <div className="mt-1.5 truncate text-fg-3">{jobStepLabel(t, fmt.lang, current) ?? jobPhaseLabel(t, current)}</div>
    </Link>
  );
}

function ThemeToggle() {
  const { update } = useSettings();
  const resolved = useResolvedTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';
  const t = useT();
  const label = t(next === 'dark' ? 'common.themeDark' : 'common.themeLight');
  return (
    <button
      onClick={() => void update({ theme: next })}
      className="grid size-8 place-items-center rounded-control text-fg-3 hover:bg-surface-2 hover:text-fg"
      title={label}
      aria-label={label}
    >
      {resolved === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

/** Global indicator of the athlete's watch (Settings → My watch) and, for COROS, the sync state. */
function WatchBadge({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const fmt = useFormat();
  const { settings } = useSettings();
  const src = useDataSources().data;
  const watch = settings.watch;
  const name = t(`common.watch.${watch}`);
  let hint: string;
  let tone: 'good' | 'warning' | 'neutral' = 'neutral';
  let to = '/settings';
  if (watch === 'coros') {
    to = '/connect';
    if (!src?.coros.connected) {
      hint = t('common.watch.corosOff');
      tone = 'warning';
    } else if (src.coros.lastError) {
      hint = t('common.watch.corosError');
      tone = 'warning';
    } else if (src.coros.lastSyncAt) {
      hint = t('common.watch.corosSynced', { when: fmt.relative(src.coros.lastSyncAt) });
      tone = 'good';
    } else hint = t('common.watch.corosNever');
  } else if (watch === 'other') {
    hint = t('common.watch.otherHint', { count: src?.fitWorkouts ?? 0 });
  } else hint = t('common.watch.appleHint');
  return (
    <Link
      to={to}
      onClick={onNavigate}
      title={t('common.watch.change', { watch: name })}
      className="flex items-center gap-2.5 rounded-control px-2 py-1.5 transition-colors hover:bg-surface-2"
    >
      <span className="relative grid size-7 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-fg">
        <Watch size={15} aria-hidden />
        <span
          className={cn(
            'absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-surface',
            tone === 'good' ? 'bg-good' : tone === 'warning' ? 'bg-warning' : 'hidden',
          )}
        />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold text-fg">{name}</span>
        <span className="block truncate text-[11px] text-fg-3">{hint}</span>
      </span>
    </Link>
  );
}

const moveButton =
  'grid size-6 shrink-0 place-items-center rounded-control text-fg-3 hover:bg-surface-3 hover:text-fg disabled:pointer-events-none disabled:opacity-30';

function MoveButtons({
  name,
  group,
  index,
  count,
  onMove,
}: {
  name: string;
  /** A group is moved, not a page (a group and a page can have the same name, e.g. "Health"). */
  group?: boolean;
  index: number;
  count: number;
  onMove: (to: number) => void;
}) {
  const t = useT();
  const up = t(group ? 'common.navEdit.moveGroupUp' : 'common.navEdit.moveUp', { name });
  const down = t(group ? 'common.navEdit.moveGroupDown' : 'common.navEdit.moveDown', { name });
  return (
    <>
      <button type="button" className={moveButton} disabled={index === 0} aria-label={up} title={up} onClick={() => onMove(index - 1)}>
        <ChevronUp size={14} aria-hidden />
      </button>
      <button
        type="button"
        className={moveButton}
        disabled={index === count - 1}
        aria-label={down}
        title={down}
        onClick={() => onMove(index + 1)}
      >
        <ChevronDown size={14} aria-hidden />
      </button>
    </>
  );
}

/**
 * The navigation while its order is edited: pages are dragged inside their group or moved with the arrows (also by
 * keyboard and touch), groups with the arrows next to their name. The rows are not links.
 */
function NavEditor({
  nav,
  onPreview,
  onChange,
}: {
  nav: Nav;
  /** A move while dragging: shown, saved when the drag ends. */
  onPreview: (next: NavPrefs) => void;
  onChange: (next: NavPrefs) => void;
}) {
  const t = useT();
  const [dragging, setDragging] = useState<{ group: NavGroup; path: string } | null>(null);
  const latest = useRef<NavPrefs | null>(null);

  const over = (e: DragEvent<HTMLDivElement>, group: NavGroup, index: number) => {
    if (!dragging || dragging.group !== group) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const items = nav.shown.find((g) => g.group === group)!.items;
    const from = items.findIndex((i) => i.path === dragging.path);
    if (from < 0 || from === index) return;
    // swap once the pointer is past the middle of the row it moves over, so the rows do not flicker
    const rect = e.currentTarget.getBoundingClientRect();
    const middle = rect.top + rect.height / 2;
    if ((from < index && e.clientY < middle) || (from > index && e.clientY > middle)) return;
    latest.current = withItemMoved(nav, group, from, index);
    onPreview(latest.current);
  };
  const end = () => {
    setDragging(null);
    if (latest.current) onChange(latest.current);
    latest.current = null;
  };

  return (
    <>
      {nav.shown.map((g, gi) => (
        <div key={g.group}>
          <div className="flex items-center gap-0.5 pb-1 pl-2.5 pr-1">
            <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-fg-3">
              {t(`common.nav.${g.group}`)}
            </span>
            <MoveButtons
              name={t(`common.nav.${g.group}`)}
              group
              index={gi}
              count={nav.shown.length}
              onMove={(to) => onChange(withGroupMoved(nav, gi, to))}
            />
          </div>
          <div className="space-y-0.5">
            {g.items.map((it, i) => {
              const Icon = it.icon;
              const name = t(it.labelKey);
              return (
                <div
                  key={it.path}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', name);
                    setDragging({ group: g.group, path: it.path });
                  }}
                  onDragOver={(e) => over(e, g.group, i)}
                  onDrop={(e) => e.preventDefault()}
                  onDragEnd={end}
                  className={cn(
                    'flex cursor-grab items-center gap-1.5 rounded-control border border-transparent py-0.5 pl-1 pr-1 text-sm font-medium text-fg-2 hover:bg-surface-2',
                    dragging?.path === it.path && 'border-border-strong bg-surface-2 opacity-60',
                  )}
                >
                  <GripVertical size={14} className="shrink-0 text-fg-3" aria-hidden />
                  <Icon size={16} className="shrink-0 text-fg-3" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <MoveButtons
                    name={name}
                    index={i}
                    count={g.items.length}
                    onMove={(to) => onChange(withItemMoved(nav, g.group, i, to))}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const { athlete, settings, update } = useSettings();
  const [editing, setEditing] = useState(false);
  // the order being edited: shown at once, saved in the background (one request after the other)
  const [draft, setDraft] = useState<NavPrefs | null>(null);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const savedPrefs = useMemo<NavPrefs>(
    () => ({ order: settings.navOrder ?? [], groups: settings.navGroups ?? [] }),
    [settings.navOrder, settings.navGroups],
  );
  const nav = useNav(draft ?? savedPrefs);
  const save = (next: NavPrefs) => {
    setDraft(next);
    saving.current = saving.current
      .then(() => update({ navOrder: [...next.order], navGroups: [...next.groups] }, { refetch: false }))
      .catch(() => undefined);
  };
  const finish = () => {
    setEditing(false);
    void saving.current.then(() => setDraft(null));
  };
  const shownPrefs = draft ?? savedPrefs;
  const custom = shownPrefs.order.length > 0 || shownPrefs.groups.length > 0;
  return (
    <div className="flex h-full flex-col">
      {/* in the drawer the close button sits in the top right corner */}
      <div className={cn('flex items-center justify-between px-4 pb-3 pt-4', onNavigate && 'pr-11')}>
        <Link to="/" onClick={onNavigate} className="flex items-center gap-2">
          <Logo size={28} />
          <span className="text-[17px] font-semibold tracking-tight text-fg">{t('common.appName')}</span>
        </Link>
        <ThemeToggle />
      </div>
      <nav className="flex-1 space-y-4 overflow-y-auto px-2.5 pb-4 scrollbar-thin">
        {editing ? (
          <>
            {/* stays in view while the list scrolls */}
            <div className="sticky top-0 z-10 -mx-2.5 space-y-2 border-b border-border bg-surface px-3.5 pb-2.5">
              <p className="text-xs text-fg-3">{t('common.navEdit.hint')}</p>
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  disabled={!custom}
                  onClick={() => save({ order: [], groups: [] })}
                  className="-ml-2 rounded-control px-2 py-1.5 text-xs font-medium text-fg-3 hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-40"
                >
                  {t('common.navEdit.reset')}
                </button>
                <button
                  type="button"
                  onClick={finish}
                  className="rounded-control bg-accent-strong px-3 py-1.5 text-xs font-medium text-on-accent hover:brightness-110"
                >
                  {t('common.navEdit.done')}
                </button>
              </div>
            </div>
            <NavEditor nav={nav} onPreview={setDraft} onChange={save} />
          </>
        ) : (
          <>
            {nav.shown.map((g) => (
              <div key={g.group}>
                <div className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-fg-3">
                  {t(`common.nav.${g.group}`)}
                </div>
                <div className="space-y-0.5">
                  {g.items.map((it) => (
                    <NavEntry key={it.path} item={it} onNavigate={onNavigate} />
                  ))}
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-xs font-medium text-fg-3 hover:bg-surface-2 hover:text-fg"
            >
              <ArrowUpDown size={15} aria-hidden />
              {t('common.navEdit.start')}
            </button>
          </>
        )}
      </nav>
      <div className="space-y-2 border-t border-border p-3">
        <ImportIndicator />
        <WatchBadge onNavigate={onNavigate} />
        {athlete && (
          <div className="flex items-center gap-2 px-1 text-xs text-fg-3">
            <span className="grid size-6 place-items-center rounded-full bg-surface-3 text-[11px] font-semibold text-fg-2">
              {athlete.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="truncate">{athlete.name}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Scroll position of the content area: a new page starts at the top, going back (or forward) returns to where the
 * page was left — e.g. back from an activity to the same spot in the feed. The content of the page may still be
 * loading, so the position is applied again for a moment until it can be reached; any input of the user stops that.
 */
function useScrollRestoration(): void {
  const location = useLocation();
  const type = useNavigationType();
  const positions = useRef(new Map<string, number>());
  const lastPath = useRef(location.pathname);

  // remember the position of the entry that is shown
  useEffect(() => {
    const main = document.querySelector('main');
    if (!main) return;
    const key = location.key;
    const onScroll = () => positions.current.set(key, main.scrollTop);
    main.addEventListener('scroll', onScroll, { passive: true });
    return () => main.removeEventListener('scroll', onScroll);
  }, [location.key]);

  useEffect(() => {
    const main = document.querySelector('main');
    if (!main) return;
    const samePage = lastPath.current === location.pathname;
    lastPath.current = location.pathname;
    if (type !== 'POP') {
      // filters and tabs change the query of the same page: stay where you are
      if (!samePage) main.scrollTo({ top: 0 });
      return;
    }
    const target = positions.current.get(location.key) ?? 0;
    let frame = 0;
    let tries = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      for (const e of USER_INPUT) main.removeEventListener(e, stop);
    };
    const apply = () => {
      main.scrollTo({ top: target });
      if (Math.abs(main.scrollTop - target) > 2 && tries++ < 120) frame = requestAnimationFrame(apply);
      else stop();
    };
    for (const e of USER_INPUT) main.addEventListener(e, stop, { passive: true });
    apply();
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);
}
const USER_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/** App frame: sidebar navigation (drawer on small screens) + routed content. */
export function AppShell() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigation = useNavigation();
  const t = useT();
  useEffect(() => setOpen(false), [location.pathname]);
  useScrollRestoration();

  return (
    <div className="flex h-full bg-bg">
      <aside className="hidden w-60 shrink-0 border-r border-border bg-surface lg:block">
        <Sidebar />
      </aside>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-border bg-surface shadow-pop">
            <button
              className="absolute right-2 top-4 grid size-8 place-items-center rounded-control text-fg-3"
              onClick={() => setOpen(false)}
              aria-label={t('common.close')}
            >
              <X size={18} />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-2 border-b border-border bg-surface px-3 lg:hidden">
          <button
            className="grid size-8 place-items-center rounded-control text-fg-2"
            onClick={() => setOpen(true)}
            aria-label={t('common.menu')}
          >
            <Menu size={18} />
          </button>
          <Logo size={22} />
          <span className="font-semibold">{t('common.appName')}</span>
        </header>
        {navigation.state === 'loading' && (
          <div className="fixed inset-x-0 top-0 z-50 h-0.5 animate-pulse bg-accent" aria-hidden />
        )}
        <main className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
