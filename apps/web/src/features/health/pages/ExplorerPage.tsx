import { useMemo, useState } from 'react';
import { Activity, ChevronRight, Database, FileHeart, Heart, Search, Stethoscope, Waves } from 'lucide-react';
import { Link } from 'react-router';
import {
  HEALTH_CATEGORIES,
  metricCategory,
  metricName,
  type ExplorerItem,
  type ExplorerResponse,
  type ExplorerType,
  type HealthCategory,
} from '@cadence/shared';
import { Button, Card, CardHeader, EmptyState, ErrorState, Input, Page, PageHeader, Skeleton, Table, TD, TH, cn } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useI18n, useT } from '@/lib/i18n';
import { Spark } from '../components/Spark';

const browserTz = () => -new Date().getTimezoneOffset();

const ITEM_LINK: Record<string, string> = {
  ecg: '/health/ecg',
  correlations: '/health/body',
  workouts: '/activities',
};

function itemIcon(key: string) {
  if (key === 'ecg') return Activity;
  if (key === 'correlations') return Heart;
  if (key === 'audiogram') return Waves;
  if (key === 'clinicalRecord' || key === 'visionPrescription') return Stethoscope;
  return FileHeart;
}

function OtherItems({ items }: { items: ExplorerItem[] }) {
  const t = useT();
  const fmt = useFormat();
  if (!items.length) return null;
  return (
    <Card>
      <CardHeader title={t('health.explorer.items.title')} subtitle={t('health.explorer.items.subtitle')} icon={FileHeart} />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,230px),1fr))] gap-3">
        {items.map((it) => {
          const Icon = itemIcon(it.key);
          const label = it.key.startsWith('other:')
            ? t('health.explorer.items.other', { kind: it.key.slice(6) })
            : t(`health.explorer.items.${it.key}`);
          const link = ITEM_LINK[it.key];
          const body = (
            <div className="flex h-full items-start gap-3 rounded-control border border-border bg-surface-2/60 p-3 transition-colors hover:bg-surface-2">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface text-fg-3">
                <Icon size={17} aria-hidden />
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-fg">{label}</div>
                <div className="text-xs text-fg-3 tabular">{t('health.explorer.items.count', { count: fmt.int(it.count) })}</div>
                {it.firstTs !== null && it.lastTs !== null && (
                  <div className="truncate text-xs text-fg-3">
                    {fmt.date(it.firstTs, browserTz(), 'day')} – {fmt.date(it.lastTs, browserTz(), 'day')}
                  </div>
                )}
              </div>
              {link && <ChevronRight size={15} className="ml-auto mt-1 shrink-0 text-fg-3" aria-hidden />}
            </div>
          );
          return link ? (
            <Link key={it.key} to={link} aria-label={`${label} – ${t('health.explorer.items.open')}`}>
              {body}
            </Link>
          ) : (
            <div key={it.key}>{body}</div>
          );
        })}
      </div>
    </Card>
  );
}

function TypeRow({ type }: { type: ExplorerType }) {
  const fmt = useFormat();
  const { lang } = useI18n();
  const name = metricName(type.identifier, lang);
  return (
    <tr className="group relative hover:bg-surface-2/70">
      <TD className="max-w-0 w-[44%]">
        <Link
          to={`/health/explorer/${encodeURIComponent(type.identifier)}`}
          className="block min-w-0 after:absolute after:inset-0 after:content-['']"
        >
          <div className="truncate font-medium text-fg">{name}</div>
          <div className="truncate text-[11px] text-fg-3">{type.identifier.replace(/^HK\w+?TypeIdentifier/, '')}</div>
        </Link>
      </TD>
      <TD numeric>{fmt.int(type.count)}</TD>
      <TD className="hidden whitespace-nowrap text-xs text-fg-3 md:table-cell">
        {type.firstTs !== null ? fmt.date(type.firstTs, browserTz(), 'day') : '–'} –{' '}
        {type.lastTs !== null ? fmt.date(type.lastTs, browserTz(), 'day') : '–'}
      </TD>
      <TD className="hidden w-[120px] sm:table-cell">
        <Spark data={type.spark} height={26} dot={false} ariaLabel={name} />
      </TD>
      <TD className="w-6 pr-2 text-right text-fg-3">
        <ChevronRight size={15} className="inline" aria-hidden />
      </TD>
    </tr>
  );
}

export default function ExplorerPage() {
  const t = useT();
  const fmt = useFormat();
  const { lang } = useI18n();
  const q = useApi<ExplorerResponse>(['health', 'explorer'], '/health/explorer');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | HealthCategory>('all');

  const typed = useMemo(
    () =>
      (q.data?.types ?? []).map((ty) => ({
        ty,
        name: metricName(ty.identifier, lang),
        cat: metricCategory(ty.identifier),
      })),
    [q.data, lang],
  );

  const counts = useMemo(() => {
    const c = new Map<HealthCategory, number>();
    for (const x of typed) c.set(x.cat, (c.get(x.cat) ?? 0) + 1);
    return c;
  }, [typed]);

  const needle = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const matches = typed.filter(
      (x) =>
        (category === 'all' || x.cat === category) &&
        (!needle || x.name.toLowerCase().includes(needle) || x.ty.identifier.toLowerCase().includes(needle)),
    );
    return HEALTH_CATEGORIES.map((c) => ({
      cat: c,
      rows: matches.filter((x) => x.cat === c.key).sort((a, b) => a.name.localeCompare(b.name, lang)),
    })).filter((g) => g.rows.length);
  }, [typed, category, needle, lang]);

  const totalSamples = (q.data?.types ?? []).reduce((s, x) => s + x.count, 0);
  const shown = groups.reduce((s, g) => s + g.rows.length, 0);

  return (
    <Page>
      <PageHeader
        title={t('health.titles.ExplorerPage')}
        subtitle={q.data ? t('health.explorer.summary', { types: fmt.int(q.data.types.length), samples: fmt.int(totalSamples) }) : t('health.explorer.subtitle')}
        icon={Database}
      >
        <div className="flex flex-col gap-3">
          <div className="relative max-w-md">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3" aria-hidden />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('health.explorer.search')}
              aria-label={t('health.explorer.searchLabel')}
              className="pl-9"
            />
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('health.explorer.category')}>
            {[{ key: 'all' as const, label: t('health.explorer.all'), n: typed.length }, ...HEALTH_CATEGORIES.filter((c) => counts.has(c.key)).map((c) => ({ key: c.key, label: c[lang], n: counts.get(c.key)! }))].map((c) => (
              <button
                key={c.key}
                type="button"
                aria-pressed={category === c.key}
                onClick={() => setCategory(c.key)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                  category === c.key ? 'border-accent bg-accent-soft text-fg' : 'border-border bg-surface text-fg-2 hover:bg-surface-2',
                )}
              >
                {c.label}
                <span className="tabular text-fg-3">{c.n}</span>
              </button>
            ))}
          </div>
        </div>
      </PageHeader>

      {q.error && <ErrorState error={q.error} className="mb-4" />}

      {q.isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-[260px] w-full" />
          <Skeleton className="h-[260px] w-full" />
        </div>
      )}

      {q.data && q.data.types.length === 0 && (
        <Card>
          <EmptyState
            icon={Database}
            title={t('health.explorer.empty.title')}
            description={t('health.explorer.empty.description')}
            action={
              <Link to="/import">
                <Button>{t('common.importNow')}</Button>
              </Link>
            }
          />
        </Card>
      )}

      {q.data && q.data.types.length > 0 && (
        <div className="space-y-4">
          {shown === 0 && (
            <Card>
              <p className="py-8 text-center text-sm text-fg-3">{t('health.explorer.noMatch', { query })}</p>
            </Card>
          )}
          {groups.map((g) => (
            <Card key={g.cat.key} padded={false} className="overflow-hidden">
              <div className="flex items-center justify-between px-4 pb-1 pt-4 sm:px-5">
                <h2 className="text-sm font-semibold text-fg">{g.cat[lang]}</h2>
                <span className="text-xs text-fg-3 tabular">{g.rows.length}</span>
              </div>
              <Table>
                <thead>
                  <tr>
                    <TH>{t('health.explorer.name')}</TH>
                    <TH numeric>{t('health.explorer.samples')}</TH>
                    <TH className="hidden md:table-cell">{t('health.explorer.period')}</TH>
                    <TH className="hidden sm:table-cell">{t('health.explorer.trend')}</TH>
                    <TH />
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((x) => (
                    <TypeRow key={x.ty.identifier} type={x.ty} />
                  ))}
                </tbody>
              </Table>
            </Card>
          ))}
          {!needle && category === 'all' && <OtherItems items={q.data.items} />}
        </div>
      )}
    </Page>
  );
}
