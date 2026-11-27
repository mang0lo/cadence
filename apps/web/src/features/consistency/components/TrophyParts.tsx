import { useState } from 'react';
import { Link } from 'react-router';
import { Activity, CalendarCheck, Check, Mountain, Repeat, type LucideIcon } from 'lucide-react';
import {
  TRIATHLON_DISTANCES,
  workoutTitle,
  type Achievement,
  type ChallengeDef,
  type ChallengeMonth,
  type ChallengeProgress,
} from '@cadence/shared';
import { Badge, Button, ProgressBar, Table, TD, TH, cn } from '@/components/ui';
import { useFormat, type Formatter } from '@/lib/format';
import { useI18n, type Lang, type TFunction } from '@/lib/i18n';
import { sportIcon, sportLabel } from '@/lib/sports';
import { classicDistance, goalElevation, type GoalRounding } from '../lib';
import { achievementIcon, Medallion } from './Medallion';

export function achievementTitle(a: Achievement, t: TFunction, fmt: Formatter, lang: Lang): string {
  if (a.name) return t(`consistency.trophies.names.${a.name}`);
  const vars = {
    count: a.threshold,
    distance: classicDistance(fmt, a.threshold),
    elevation: fmt.elevation(a.threshold),
    sport: a.sport ? sportLabel(a.sport, lang) : '',
  };
  return t(`consistency.trophies.kinds.${a.kind}.title`, vars);
}

export function achievementDesc(a: Achievement, t: TFunction, fmt: Formatter, lang: Lang): string {
  const vars = {
    count: a.threshold,
    distance: classicDistance(fmt, a.threshold),
    elevation: fmt.elevation(a.threshold),
    sport: a.sport ? sportLabel(a.sport, lang) : '',
  };
  if (a.kind === 'elevation' && a.name) return t(`consistency.trophies.nameDesc.${a.name}`, vars);
  if (a.kind === 'triathlon') {
    const tri = TRIATHLON_DISTANCES.find((d) => d.key === a.name);
    if (tri)
      return t('consistency.trophies.kinds.triathlon.desc', {
        swim: classicDistance(fmt, tri.swim),
        ride: classicDistance(fmt, tri.ride),
        run: classicDistance(fmt, tri.run),
      });
  }
  return t(`consistency.trophies.kinds.${a.kind}.desc`, vars);
}

/** "12.4 / 50 km", "16 / 30 days", "3 / 10" */
export function achievementProgress(a: Achievement, t: TFunction, fmt: Formatter): string {
  switch (a.kind) {
    // the progress rounds down: 49.96 of 50 km is not "50 km / 50 km"
    case 'sport_distance':
    case 'longest':
    case 'triathlon':
      return `${classicDistance(fmt, a.progress, 'down')} / ${classicDistance(fmt, a.threshold)}`;
    case 'elevation':
      return `${goalElevation(fmt, a.progress, 'down')} / ${fmt.elevation(a.threshold)}`;
    case 'daily_streak':
    case 'move_streak':
    case 'exercise_streak':
    case 'stand_streak':
      return `${fmt.int(a.progress)} / ${t('common.days', { count: a.threshold })}`;
    case 'weekly_streak':
      return `${fmt.int(a.progress)} / ${t('common.weeks', { count: a.threshold })}`;
    default:
      return `${fmt.int(a.progress)} / ${fmt.int(a.threshold)}`;
  }
}

/** One trophy: medallion, title, description and either the earned day + activity or the progress. */
export function AchievementTile({ a }: { a: Achievement }) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const title = achievementTitle(a, t, fmt, lang);
  const tier = t(`consistency.trophies.tiers.${a.tier}`);
  return (
    <div className={cn('flex min-w-0 gap-3 rounded-card border border-border p-3', a.earned ? 'bg-surface' : 'bg-surface/60')}>
      <Medallion
        tier={a.tier}
        icon={achievementIcon(a)}
        locked={!a.earned}
        size={56}
        label={`${tier}: ${a.earned ? t('consistency.trophies.earned') : t('consistency.trophies.locked')}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <h3 className={cn('text-sm font-semibold', a.earned ? 'text-fg' : 'text-fg-2')}>{title}</h3>
          {a.isNew && <Badge tone="accent">{t('consistency.trophies.new')}</Badge>}
        </div>
        <p className="text-xs text-fg-3">{achievementDesc(a, t, fmt, lang)}</p>
        {a.earned ? (
          <div className="mt-1.5 text-xs text-fg-2">
            <span className="tabular">{fmt.day(a.earnedDay!, 'day')}</span>
            {a.workout && (
              <>
                {' · '}
                <Link to={`/activities/${a.workout.id}`} className="font-medium text-accent-fg hover:underline">
                  {workoutTitle(a.workout, lang)}
                </Link>
              </>
            )}
          </div>
        ) : (
          <div className="mt-2">
            <ProgressBar value={a.threshold ? a.progress / a.threshold : 0} height={6} color="var(--axis)" label={title} />
            <div className="mt-1 text-xs tabular text-fg-3">{achievementProgress(a, t, fmt)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

const CHALLENGE_ICONS: Record<string, LucideIcon> = {
  climb1000: Mountain,
  activities10: Activity,
  runs5k: Repeat,
  active20: CalendarCheck,
};

export function challengeIcon(def: ChallengeDef): LucideIcon {
  return CHALLENGE_ICONS[def.key] ?? (def.sport ? sportIcon(def.sport) : Activity);
}

export function challengeTitle(def: ChallengeDef, t: TFunction, fmt: Formatter): string {
  return t(`consistency.challenges.names.${def.key}`, {
    distance: classicDistance(fmt, def.metric === 'runs5k' ? 5000 : def.target),
    elevation: fmt.elevation(def.target),
    count: def.target,
  });
}

/** `rounding` 'down' for the progress of an open challenge (never printed as its target before it is reached). */
export function challengeValue(def: ChallengeDef, v: number, fmt: Formatter, rounding: GoalRounding = 'nearest'): string {
  if (def.metric === 'distance') return classicDistance(fmt, v, rounding);
  if (def.metric === 'elevation') return goalElevation(fmt, v, rounding);
  return fmt.int(rounding === 'down' ? Math.floor(v) : v);
}

/** Current month's challenge with progress (or the completion day). */
export function ChallengeItem({ def, item }: { def: ChallengeDef; item: ChallengeProgress }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const done = item.completedDay !== null;
  const Icon = challengeIcon(def);
  return (
    <div className="min-w-0 rounded-card border border-border p-3">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'grid size-10 shrink-0 place-items-center rounded-full',
            done ? 'bg-accent text-on-accent' : 'bg-surface-2 text-fg-2',
          )}
        >
          {done ? <Check size={18} strokeWidth={3} aria-hidden /> : <Icon size={18} aria-hidden />}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-fg">{challengeTitle(def, t, fmt)}</div>
          <div className="truncate text-xs text-fg-3">
            {done
              ? t('consistency.challenges.completedOn', { date: fmt.day(item.completedDay!, 'dayShort') })
              : `${challengeValue(def, item.value, fmt, 'down')} / ${challengeValue(def, def.target, fmt)}`}
          </div>
        </div>
      </div>
      <ProgressBar className="mt-3" value={item.value / item.target} height={6} label={challengeTitle(def, t, fmt)} />
    </div>
  );
}

/** Months × challenges grid of completions (newest first). */
export function ChallengeHistory({ defs, history }: { defs: ChallengeDef[]; history: ChallengeMonth[] }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const [all, setAll] = useState(false);
  const rows = all ? history : history.slice(0, 12);
  return (
    <div>
      <Table className="max-h-[28rem]">
        <thead>
          <tr>
            <TH>{t('common.month')}</TH>
            {defs.map((d) => (
              <TH key={d.key} numeric>
                {challengeTitle(d, t, fmt)}
              </TH>
            ))}
            <TH numeric>{t('consistency.challenges.done')}</TH>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.month}>
              <TD className="whitespace-nowrap">{fmt.day(`${m.month}-01`, 'month')}</TD>
              {defs.map((d) => {
                const it = m.items.find((i) => i.key === d.key);
                return (
                  <TD key={d.key} numeric>
                    {it?.completedDay ? (
                      <span className="relative inline-flex items-center justify-end gap-1 text-fg" title={fmt.day(it.completedDay, 'day')}>
                        <Check size={15} strokeWidth={3} className="text-accent-fg" aria-hidden />
                        <span className="sr-only">{t('consistency.challenges.completedOn', { date: fmt.day(it.completedDay, 'day') })}</span>
                        <span className="text-xs text-fg-3">{fmt.day(it.completedDay, 'dayShort')}</span>
                      </span>
                    ) : (
                      <span className="text-xs text-fg-3">{it ? fmt.pct(Math.min(1, it.value / it.target)) : '–'}</span>
                    )}
                  </TD>
                );
              })}
              <TD numeric className="font-medium text-fg">
                {m.completed}/{defs.length}
              </TD>
            </tr>
          ))}
        </tbody>
      </Table>
      {history.length > 12 && (
        <div className="mt-2 flex justify-center">
          <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
            {all ? t('consistency.challenges.showLess') : t('consistency.challenges.showAll', { count: history.length })}
          </Button>
        </div>
      )}
    </div>
  );
}
