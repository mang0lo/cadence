import { useMemo, useState } from 'react';
import { History, Medal, Swords, Trophy } from 'lucide-react';
import { ACHIEVEMENT_GROUPS, ACHIEVEMENT_TIERS, type Achievement } from '@cadence/shared';
import { Button, Card, CardHeader, EmptyState, ErrorState, FilterBar, Page, PageHeader, ProgressBar, SegmentedControl, Skeleton } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { sortSports } from '@/lib/sports';
import { useStoredState } from '@/lib/storage';
import { useTrophies } from '../api';
import { AsOfNote } from '../components/AsOfNote';
import { achievementIcon, Medallion } from '../components/Medallion';
import { AchievementTile, achievementTitle, ChallengeHistory, ChallengeItem } from '../components/TrophyParts';

type Filter = 'all' | 'earned' | 'locked';

/**
 * Ladders (same kind + sport) in catalog order, each sorted by threshold; sport ladders follow the fixed
 * sport order.
 */
function ladders(list: Achievement[]): Achievement[][] {
  const by = new Map<string, Achievement[]>();
  for (const a of list) {
    const k = `${a.kind}|${a.sport ?? ''}`;
    let l = by.get(k);
    if (!l) by.set(k, (l = []));
    l.push(a);
  }
  const sports = sortSports([...new Set(list.map((a) => a.sport).filter((s): s is string => !!s))]);
  const kinds = [...new Set(list.map((a) => a.kind))];
  return [...by.values()]
    .map((l) => [...l].sort((a, b) => a.threshold - b.threshold))
    .sort((a, b) => {
      const x = a[0]!;
      const y = b[0]!;
      return kinds.indexOf(x.kind) - kinds.indexOf(y.kind) || (x.sport ? sports.indexOf(x.sport) : -1) - (y.sport ? sports.indexOf(y.sport) : -1);
    });
}

export default function TrophiesPage() {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const q = useTrophies();
  const [filter, setFilter] = useStoredState<Filter>('consistency.trophyFilter', 'all');
  const d = q.data;

  const recent = useMemo(
    () =>
      (d?.achievements ?? [])
        .filter((a) => a.earned)
        .sort((a, b) => (a.earnedDay! < b.earnedDay! ? 1 : a.earnedDay! > b.earnedDay! ? -1 : 0))
        .slice(0, 5),
    [d],
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const groups = useMemo(
    () =>
      ACHIEVEMENT_GROUPS.map((g) => {
        const all = (d?.achievements ?? []).filter((a) => a.group === g);
        const shown: Achievement[] = [];
        let hidden = 0;
        for (const ladder of ladders(all)) {
          const next = ladder.find((a) => !a.earned);
          for (const a of ladder) {
            if (filter === 'earned' && !a.earned) continue;
            if (filter === 'locked' && a.earned) continue;
            // 'all': earned ones + the next step of each ladder, the rest on demand
            if (filter === 'all' && !a.earned && a !== next && !expanded.has(g)) {
              hidden++;
              continue;
            }
            shown.push(a);
          }
        }
        return { group: g, earned: all.filter((a) => a.earned).length, total: all.length, shown, hidden };
      }).filter((g) => g.total > 0),
    [d, filter, expanded],
  );
  const toggle = (g: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  return (
    <Page>
      <PageHeader
        title={t('consistency.trophies.title')}
        subtitle={d ? t('consistency.trophies.subtitle', { earned: d.summary.earned, total: d.summary.total }) : t('consistency.trophies.tagline')}
        icon={Trophy}
      />
      {q.error ? (
        <ErrorState error={q.error} />
      ) : !d ? (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <Skeleton className="h-56 rounded-card" />
            <Skeleton className="h-56 rounded-card" />
          </div>
          <Skeleton className="h-48 rounded-card" />
        </div>
      ) : (
        <div className="space-y-4">
          <AsOfNote asOf={d.asOf} today={d.today} />
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <Card>
              <CardHeader title={t('consistency.trophies.collection')} icon={Medal} />
              <div className="flex items-baseline gap-1.5">
                <span className="text-4xl font-semibold tracking-tight text-fg">{fmt.int(d.summary.earned)}</span>
                <span className="text-sm text-fg-3">{t('consistency.trophies.ofTotal', { total: d.summary.total })}</span>
              </div>
              <div className="mt-4 space-y-3">
                {[...ACHIEVEMENT_TIERS].reverse().map((tier) => {
                  const s = d.summary.tiers[tier];
                  return (
                    <div key={tier} className="flex items-center gap-3">
                      <Medallion tier={tier} icon={Trophy} size={32} label={t(`consistency.trophies.tiers.${tier}`)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex justify-between text-xs">
                          <span className="font-medium text-fg-2">{t(`consistency.trophies.tiers.${tier}`)}</span>
                          <span className="tabular text-fg-3">
                            {s.earned} / {s.total}
                          </span>
                        </div>
                        <ProgressBar className="mt-1" value={s.total ? s.earned / s.total : 0} height={6} label={t(`consistency.trophies.tiers.${tier}`)} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
            <Card>
              <CardHeader title={t('consistency.trophies.recent')} icon={History} />
              {recent.length === 0 ? (
                <EmptyState className="py-6" icon={Trophy} title={t('consistency.trophies.noneYet')} description={t('consistency.trophies.noneYetHint')} />
              ) : (
                <ul className="divide-y divide-border">
                  {recent.map((a) => (
                    <li key={a.key} className="flex items-center gap-3 py-2">
                      <Medallion tier={a.tier} icon={achievementIcon(a)} size={36} label={t(`consistency.trophies.tiers.${a.tier}`)} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-fg">{achievementTitle(a, t, fmt, lang)}</div>
                        <div className="text-xs text-fg-3">{fmt.day(a.earnedDay!, 'day')}</div>
                      </div>
                      {a.isNew && (
                        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent-fg">
                          {t('consistency.trophies.new')}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card>
            <CardHeader
              title={t('consistency.challenges.title', { month: fmt.day(`${d.challenges.current.month}-01`, 'month') })}
              subtitle={`${t('consistency.challenges.daysLeft', { count: d.challenges.current.daysLeft })} · ${t('consistency.challenges.completedCount', {
                done: d.challenges.current.completed,
                total: d.challenges.defs.length,
              })}`}
              icon={Swords}
            />
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {d.challenges.defs.map((def) => {
                const item = d.challenges.current.items.find((i) => i.key === def.key);
                return item ? <ChallengeItem key={def.key} def={def} item={item} /> : null;
              })}
            </div>
          </Card>

          {d.challenges.history.length > 0 && (
            <Card>
              <CardHeader
                title={t('consistency.challenges.history')}
                subtitle={t('consistency.challenges.historySubtitle', { count: d.challenges.completedTotal })}
                icon={History}
              />
              <ChallengeHistory defs={d.challenges.defs} history={d.challenges.history} />
            </Card>
          )}

          <section aria-labelledby="trophies-all" className="space-y-4 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="trophies-all" className="text-lg font-semibold tracking-tight text-fg">
                {t('consistency.trophies.all')}
              </h2>
              <FilterBar>
                <SegmentedControl
                  value={filter}
                  onChange={setFilter}
                  label={t('consistency.trophies.filter')}
                  items={(['all', 'earned', 'locked'] as const).map((f) => ({ value: f, label: t(`consistency.trophies.filters.${f}`) }))}
                />
              </FilterBar>
            </div>
            {groups.every((g) => g.shown.length === 0) ? (
              <Card>
                <EmptyState icon={Trophy} title={t('consistency.trophies.nothingHere')} />
              </Card>
            ) : (
              groups
                .filter((g) => g.shown.length > 0)
                .map((g) => (
                  <section key={g.group} aria-labelledby={`grp-${g.group}`}>
                    <div className="mb-2 flex items-baseline justify-between gap-3">
                      <h3 id={`grp-${g.group}`} className="text-sm font-semibold text-fg">
                        {t(`consistency.trophies.groups.${g.group}`)}
                      </h3>
                      <span className="text-xs tabular text-fg-3">
                        {g.earned} / {g.total}
                      </span>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {g.shown.map((a) => (
                        <AchievementTile key={a.key} a={a} />
                      ))}
                    </div>
                    {filter === 'all' && (g.hidden > 0 || expanded.has(g.group)) && (
                      <Button size="sm" variant="ghost" className="mt-2" onClick={() => toggle(g.group)}>
                        {expanded.has(g.group)
                          ? t('consistency.trophies.showNext')
                          : t('consistency.trophies.showMore', { count: g.hidden })}
                      </Button>
                    )}
                  </section>
                ))
            )}
          </section>
        </div>
      )}
    </Page>
  );
}
