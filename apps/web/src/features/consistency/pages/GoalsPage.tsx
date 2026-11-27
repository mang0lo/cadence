import { useRef, useState } from 'react';
import { Lightbulb, Plus, Target } from 'lucide-react';
import type { CalendarDay, GoalInput, GoalSuggestion, GoalWithProgress } from '@cadence/shared';
import { Button, Card, CardHeader, Dialog, EmptyState, ErrorState, Page, PageHeader, Skeleton } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useCalendar, useConsistencyMutations, useGoals } from '../api';
import { AsOfNote } from '../components/AsOfNote';
import { GoalDialog } from '../components/GoalDialog';
import { GoalCard, GoalIcon } from '../components/GoalParts';
import { formatGoalValue, goalTargetText, goalTitle } from '../lib';

const suggestionKey = (s: GoalSuggestion) => `${s.period}-${s.metric}-${s.sport}`;

/** The day the goals are judged on already counts as an active day for this goal (all sports, or its sport). */
const activeOn = (day: CalendarDay | undefined, g: GoalWithProgress) =>
  !!day && day.count > 0 && (g.sport === null || day.sports.includes(g.sport));

function Suggestions({
  items,
  adding,
  onAdd,
}: {
  items: GoalSuggestion[];
  adding: ReadonlySet<string>;
  onAdd: (s: GoalSuggestion) => void;
}) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  return (
    <Card>
      <CardHeader title={t('consistency.goals.suggestions.title')} subtitle={t('consistency.goals.suggestions.subtitle')} icon={Lightbulb} />
      <ul className="divide-y divide-border">
        {items.map((s) => (
          <li key={suggestionKey(s)} className="flex items-center gap-3 py-2.5">
            <GoalIcon sport={s.sport} size={28} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-fg">
                {goalTitle(t, lang, s)} · {goalTargetText(fmt, t, s)}
              </div>
              <div className="truncate text-xs text-fg-3">
                {t(`consistency.goals.suggestions.basis.${s.period}`, {
                  count: s.periods,
                  value: formatGoalValue(fmt, t, s.metric, s.average),
                })}
              </div>
            </div>
            <Button size="sm" icon={Plus} loading={adding.has(suggestionKey(s))} onClick={() => onAdd(s)}>
              {t('consistency.goals.suggestions.add')}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default function GoalsPage() {
  const { t, lang } = useI18n();
  const q = useGoals();
  const { createGoal, deleteGoal, checkGoal } = useConsistencyMutations();
  const [dialog, setDialog] = useState<{ initial: (GoalInput & { id?: number }) | null } | null>(null);
  const [toDelete, setToDelete] = useState<GoalWithProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  // suggestions being added: the list only changes after the refetch, so a second click must not post the goal twice
  const pending = useRef(new Set<string>());
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const d = q.data;
  // "N more active days needed, M left": M must not count asOf when it already is an active day
  const asOfDay = useCalendar(d?.goals.some((g) => g.metric === 'active_days') ? { from: d.asOf, to: d.asOf } : null);
  const asOfData = asOfDay.data?.days.find((x) => x.day === d?.asOf);

  const check = async (id: number, done: boolean, day?: string) => {
    setActionError(null);
    try {
      await checkGoal(id, done, day);
    } catch (e) {
      setActionError(e);
    }
  };

  const add = async (s: GoalSuggestion) => {
    const key = suggestionKey(s);
    if (pending.current.has(key)) return;
    pending.current.add(key);
    setAdding(new Set(pending.current));
    setActionError(null);
    try {
      await createGoal({ period: s.period, sport: s.sport, metric: s.metric, target: s.target });
    } catch (e) {
      setActionError(e);
    } finally {
      pending.current.delete(key);
      setAdding(new Set(pending.current));
    }
  };

  return (
    <Page>
      <PageHeader
        title={t('consistency.goals.title')}
        subtitle={t('consistency.goals.subtitle')}
        icon={Target}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setDialog({ initial: null })}>
            {t('consistency.goals.new')}
          </Button>
        }
      />
      <div className="space-y-4">
        {q.error ? (
          <ErrorState error={q.error} />
        ) : !d ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-64 rounded-card" />
            ))}
          </div>
        ) : (
          <>
            <AsOfNote asOf={d.asOf} today={d.today} />
            {actionError ? <ErrorState error={actionError} /> : null}
            {d.goals.length === 0 ? (
              <Card>
                <EmptyState
                  icon={Target}
                  title={t('consistency.goals.empty')}
                  description={t('consistency.goals.emptyHint')}
                  action={
                    <Button variant="primary" icon={Plus} onClick={() => setDialog({ initial: null })}>
                      {t('consistency.goals.create')}
                    </Button>
                  }
                />
              </Card>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                {d.goals.map((g) => (
                  <GoalCard
                    key={g.id}
                    goal={g}
                    onEdit={() => setDialog({ initial: { id: g.id, period: g.period, sport: g.sport, metric: g.metric, target: g.target } })}
                    onDelete={() => setToDelete(g)}
                    onCheck={(done, day) => void check(g.id, done, day)}
                    onToggleHistory={(h) => void check(g.id, !h.manual, h.start)}
                    asOfActive={g.metric === 'active_days' && activeOn(asOfData, g)}
                  />
                ))}
              </div>
            )}
            {d.suggestions.length > 0 && <Suggestions items={d.suggestions} adding={adding} onAdd={(s) => void add(s)} />}
          </>
        )}
      </div>

      <GoalDialog open={!!dialog} initial={dialog?.initial ?? null} onClose={() => setDialog(null)} />

      <Dialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title={t('consistency.goals.delete')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setToDelete(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                if (!toDelete) return;
                setBusy(true);
                setActionError(null);
                try {
                  await deleteGoal(toDelete.id);
                } catch (e) {
                  setActionError(e);
                } finally {
                  setBusy(false);
                  setToDelete(null);
                }
              }}
            >
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-2">
          {toDelete && t('consistency.goals.deleteConfirm', { title: `${goalTitle(t, lang, toDelete)} · ${t(`consistency.goals.periods.${toDelete.period}`)}` })}
        </p>
      </Dialog>
    </Page>
  );
}
