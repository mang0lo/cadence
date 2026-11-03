import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigation } from 'react-router';
import { Menu, Moon, Sparkles, Sun, X } from 'lucide-react';
import { featureModules } from '@/features/registry';
import type { NavGroup, NavItem } from '@/features/types';
import { useImportJobs } from '@/features/platform/useImportJobs';
import { latestSummaryJob, markSummarySeen, summaryCounts, useSeenSummaryId } from '@/features/platform/whatsNewState';
import { cn, ProgressBar } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { useResolvedTheme } from '@/lib/theme';
import { Logo } from './Logo';

const GROUPS: NavGroup[] = ['training', 'habits', 'explore', 'health', 'app'];

function useNav() {
  return useMemo(() => {
    const items = featureModules.flatMap((f) => f.nav);
    // An item whose path prefixes another item must match exactly, else both would be active.
    const withEnd = items.map((it) => ({
      ...it,
      end: it.end || it.path === '/' || items.some((o) => o !== it && o.path.startsWith(`${it.path}/`)),
    }));
    return GROUPS.map((g) => ({
      group: g,
      items: withEnd.filter((i) => i.group === g).sort((a, b) => a.order - b.order),
    })).filter((g) => g.items.length);
  }, []);
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
    t(s.initial ? 'platform.whatsNew.initial' : 'platform.whatsNew.activities', { count: s.count, n: fmt.int(s.count) }),
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
  const { active } = useImportJobs();
  if (!active) return <WhatsNewNote />;
  return (
    <Link to="/import" className="block rounded-control border border-border bg-surface-2 p-2.5 text-xs">
      <div className="mb-1.5 flex items-center justify-between font-medium text-fg">
        <span>{t('common.importRunning')}</span>
        <span className="tabular text-fg-3">{Math.round(active.progress * 100)}%</span>
      </div>
      <ProgressBar value={active.progress} height={5} />
      {active.message && <div className="mt-1.5 truncate text-fg-3">{active.message}</div>}
    </Link>
  );
}

function ThemeToggle() {
  const { settings, update } = useSettings();
  const resolved = useResolvedTheme();
  const next = resolved === 'dark' ? 'light' : 'dark';
  return (
    <button
      onClick={() => void update({ theme: next })}
      className="grid size-8 place-items-center rounded-control text-fg-3 hover:bg-surface-2 hover:text-fg"
      title={settings.theme}
      aria-label="Toggle theme"
    >
      {resolved === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const nav = useNav();
  const { athlete } = useSettings();
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-3 pt-4">
        <Link to="/" onClick={onNavigate} className="flex items-center gap-2">
          <Logo size={28} />
          <span className="text-[17px] font-semibold tracking-tight text-fg">{t('common.appName')}</span>
        </Link>
        <ThemeToggle />
      </div>
      <nav className="flex-1 space-y-4 overflow-y-auto px-2.5 pb-4 scrollbar-thin">
        {nav.map((g) => (
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
      </nav>
      <div className="space-y-2 border-t border-border p-3">
        <ImportIndicator />
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

/** App frame: sidebar navigation (drawer on small screens) + routed content. */
export function AppShell() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigation = useNavigation();
  const t = useT();
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    document.querySelector('main')?.scrollTo({ top: 0 });
  }, [location.pathname]);

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
          <button className="grid size-8 place-items-center rounded-control text-fg-2" onClick={() => setOpen(true)} aria-label="Menu">
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
