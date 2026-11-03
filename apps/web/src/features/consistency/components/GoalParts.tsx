import { Check, CircleCheck, Flag, Pencil, Target, Trash2, TrendingDown, TrendingUp } from 'lucide-react';
import type { GoalPeriodProgress, GoalPeriodResult, GoalStatus, GoalWithProgress } from '@cadence/shared';
import { Badge, Card, Hint, IconButton, ProgressBar, cn } from '@/components/ui';
import { useFormat, type Formatter } from '@/lib/format';
import { useI18n, type TFunction } from '@/lib/i18n';
import { SportIcon, sportColorVar } from '@/lib/sports';
import { formatGoalValue, goalTargetText, goalTitle, periodLabel } from '../lib';

/** Status with icon + label (status colors are never used alone). */
export function GoalStatusBadge({ status }: { status: GoalStatus }) {
  const { t } = useI18n();
  const icon =
    status === 'done' ? CircleCheck : status === 'on_track' ? TrendingUp : status === 'open' ? Flag : TrendingDown;
  return (
    <Badge tone={status === 'behind' ? 'warning' : status === 'open' ? 'neutral' : 'good'} icon={icon}>
      {t(`consistency.goals.status.${status}`)}
    </Badge>
  );
}

/** Progress bar with a tick where a linear pace would be by today. */
export function GoalProgressBar({
  current,
  label,
  height = 10,
}: {
  current: GoalPeriodProgress;
  label: string;
  height?: number;
}) {
  const expected = current.target > 0 ? Math.min(1, current.expected / current.target) : 0;
  return (
    <div className="relative">
      <ProgressBar value={current.fraction} height={height} label={label} />
      {current.status !== 'done' && expected > 0 && expected < 1 && (
        <span
          aria-hidden
          className="absolute w-0.5 rounded-full bg-fg"
          style={{ left: `calc(${expected * 100}% - 1px)`, top: -3, height: height + 6 }}
        />
      )}
    </div>
  );
}

/** Hit / miss squares for completed periods (oldest first). */
export function GoalHistoryStrip({ goal, history }: { goal: GoalWithProgress; history: GoalPeriodResult[] }) {
  const { t } = useI18n();
  const fmt = useFormat();
  return (
    <div
      className="grid gap-1"
      style={{ gridTemplateColumns: `repeat(${Math.max(history.length, 6)}, minmax(0, 1.5rem))` }}
      role="list"
      aria-label={t(`consistency.goals.history.${goal.period}`, { count: history.length })}
    >
      {history.map((h) => {
        const text = `${periodLabel(fmt, goal.period, h.start, h.end)}: ${formatGoalValue(fmt, t, goal.metric, h.value)} — ${t(
          h.hit ? 'consistency.goals.hit' : 'consistency.goals.miss',
        )}`;
        return (
          <Hint key={h.start} content={text}>
            <span
              role="listitem"
              tabIndex={0}
              aria-label={text}
              className={cn(
                'grid aspect-square w-full place-items-center rounded-md text-on-accent',
                h.hit ? 'bg-accent' : 'bg-surface-3',
              )}
            >
              {h.hit && <Check size={13} strokeWidth={3} aria-hidden />}
            </span>
          </Hint>
        );
      })}
    </div>
  );
}

/** One line telling where the goal stands: projection, what is left per day, or that it was reached. */
export function goalOutlook(
  g: GoalWithProgress,
  t: TFunction,
  fmt: Formatter,
): string {
  const c = g.current;
  const v = (x: number) => formatGoalValue(fmt, t, g.metric, x);
  if (c.status === 'done') return t('consistency.goals.doneText', { pct: fmt.pct(c.fraction) });
  // a single effort: the longest so far and what is still missing to the target
  if (g.metric === 'longest')
    return c.value > 0
      ? t('consistency.goals.longestSoFar', { value: v(c.value), remaining: v(c.remaining), days: t('common.days', { count: c.remainingDays }) })
      : t('consistency.goals.longestNone', { days: t('common.days', { count: c.remainingDays }) });
  if (g.metric === 'active_days' && c.remaining > c.remainingDays) return t(`consistency.goals.outOfReach.${g.period}`);
  // a projection needs a pace: nothing done on the first day(s) would project 0
  const parts = c.value > 0 && c.elapsedDays > 0 ? [t(`consistency.goals.projected.${g.period}`, { value: v(c.projected) })] : [];
  if (c.perDayNeeded !== null)
    parts.push(
      g.metric === 'active_days'
        ? t('consistency.goals.remainingDays', { count: Math.ceil(c.remaining), days: t('common.days', { count: c.remainingDays }) })
        : t('consistency.goals.remaining', {
            value: v(c.remaining),
            perDay: v(c.perDayNeeded),
            days: t('common.days', { count: c.remainingDays }),
          }),
    );
  return parts.join(' · ');
}

export function GoalIcon({ sport, size = 32 }: { sport: string | null; size?: number }) {
  return sport ? (
    <span className="grid shrink-0 place-items-center rounded-full text-white" style={{ background: sportColorVar(sport), width: size, height: size }}>
      <SportIcon sport={sport} size={size * 0.5} />
    </span>
  ) : (
    <span className="grid shrink-0 place-items-center rounded-full bg-accent-soft text-accent-fg" style={{ width: size, height: size }}>
      <Target size={size * 0.5} aria-hidden />
    </span>
  );
}

/** Full goal card: value vs target, status, progress with expectation tick, outlook and history. */
export function GoalCard({
  goal,
  onEdit,
  onDelete,
}: {
  goal: GoalWithProgress;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const c = goal.current;
  const title = goalTitle(t, lang, goal);
  const hits = goal.history.filter((h) => h.hit).length;
  return (
    <Card className="flex min-w-0 flex-col">
      <div className="mb-3 flex items-start gap-3">
        <GoalIcon sport={goal.sport} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-fg">{title}</h2>
          <p className="truncate text-xs text-fg-3">{goalTargetText(fmt, t, goal)}</p>
        </div>
        <div className="-mr-1.5 -mt-1 flex shrink-0">
          {onEdit && <IconButton icon={Pencil} label={t('common.edit')} onClick={onEdit} />}
          {onDelete && <IconButton icon={Trash2} label={t('consistency.goals.delete')} onClick={onDelete} />}
        </div>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-fg-3">
            {t(`consistency.goals.current.${goal.period}`)} · {periodLabel(fmt, goal.period, c.start, c.end)}
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
            <span className="text-3xl font-semibold tracking-tight text-fg">{formatGoalValue(fmt, t, goal.metric, c.value)}</span>
            <span className="text-sm text-fg-3">{t('consistency.goals.of', { target: formatGoalValue(fmt, t, goal.metric, c.target) })}</span>
          </div>
        </div>
        <GoalStatusBadge status={c.status} />
      </div>
      <div className="mt-3">
        <GoalProgressBar current={c} label={title} />
      </div>
      <div className="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-fg-3">
        <span>{goalOutlook(goal, t, fmt)}</span>
        {c.status !== 'done' && c.expected > 0 && (
          <span className="inline-flex items-center gap-1">
            <span aria-hidden className="inline-block h-3 w-0.5 rounded-full bg-fg" />
            {t('consistency.goals.expected', { value: formatGoalValue(fmt, t, goal.metric, c.expected) })}
          </span>
        )}
      </div>
      <div className="mt-auto pt-4">
        <div className="border-t border-border pt-3">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-xs">
            <span className="font-medium text-fg-2">{t(`consistency.goals.history.${goal.period}`, { count: goal.history.length })}</span>
            {goal.history.length > 0 && (
              <span className="text-fg-3">{t('consistency.goals.hitRate', { hit: hits, total: goal.history.length })}</span>
            )}
          </div>
          {goal.history.length ? (
            <GoalHistoryStrip goal={goal} history={goal.history} />
          ) : (
            <p className="text-xs text-fg-3">{t(`consistency.goals.noHistory.${goal.period}`)}</p>
          )}
        </div>
      </div>
    </Card>
  );
}
