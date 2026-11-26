import { Link } from 'react-router';
import { HeartPulse, ListChecks, X } from 'lucide-react';
import { workoutTitle, type RingValues } from '@cadence/shared';
import { PlaceText } from '@/components/map/PlaceText';
import { Card, CardHeader, EmptyState, ErrorState, IconButton, KeyValues, Skeleton } from '@/components/ui';
import { useFormat, type Formatter } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { SportIcon, sportColorVar } from '@/lib/sports';
import { useDayDetail } from '../api';
import { RingGlyph } from './RingGlyph';

/** "1,015 / 600 kcal" */
function ringRows(fmt: Formatter, t: (k: string) => string, r: RingValues): [string, string][] {
  const of = (v: number | null, goal: number | null, unit: string) =>
    v === null ? '–' : goal ? `${fmt.int(v)} / ${fmt.int(goal)} ${unit}` : `${fmt.int(v)} ${unit}`;
  // "min" is "Min." in German; kcal and h are the same in both languages (as in fmt.energy / fmt.hours)
  const min = t('consistency.goals.unit.minutes');
  const move = r.moveGoalMin !== null ? of(r.moveMin, r.moveGoalMin, min) : of(r.moveKcal, r.moveGoalKcal, 'kcal');
  return [
    [t('consistency.rings.move'), move],
    [t('consistency.rings.exercise'), of(r.exerciseMin, r.exerciseGoalMin, min)],
    [t('consistency.rings.stand'), of(r.standHours, r.standGoalHours, 'h')],
  ];
}

/** Activities, activity rings and a health summary of the selected calendar day. */
export function DayPanel({ day, onClose }: { day: string; onClose: () => void }) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const q = useDayDetail(day);
  const d = q.data?.day === day ? q.data : null;

  const health: [string, string][] = d
    ? (
        [
          [t('consistency.day.steps'), d.health.steps !== null ? fmt.int(d.health.steps) : null],
          [t('consistency.day.walkRun'), d.health.walkRunDistanceM !== null ? fmt.distance(d.health.walkRunDistanceM) : null],
          [t('consistency.day.flights'), d.health.flights !== null ? fmt.int(d.health.flights) : null],
          [t('consistency.day.activeEnergy'), d.health.activeEnergyKcal !== null ? fmt.energy(d.health.activeEnergyKcal) : null],
          [t('consistency.day.restingHr'), d.health.restingHr !== null ? fmt.hr(d.health.restingHr) : null],
          [t('consistency.day.sleep'), d.health.sleepMin !== null ? fmt.durationShort(d.health.sleepMin * 60) : null],
        ] as [string, string | null][]
      ).filter((x): x is [string, string] => x[1] !== null)
    : [];

  return (
    <Card>
      <CardHeader
        title={fmt.day(day, 'weekday')}
        subtitle={t('consistency.day.subtitle')}
        actions={<IconButton icon={X} label={t('common.close')} onClick={onClose} />}
      />
      {q.error ? (
        <ErrorState error={q.error} />
      ) : !d ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="min-w-0">
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-3">
              <ListChecks size={14} aria-hidden />
              {t('consistency.day.activities')}
            </h3>
            {d.workouts.length === 0 ? (
              <EmptyState className="py-6" title={t('consistency.day.noActivities')} />
            ) : (
              <ul className="divide-y divide-border">
                {d.workouts.map((w) => (
                  <li key={w.id} className="flex items-center gap-3 py-2">
                    <span
                      className="grid size-8 shrink-0 place-items-center rounded-full text-white"
                      style={{ background: sportColorVar(w.sport) }}
                    >
                      <SportIcon sport={w.sport} size={16} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <Link to={`/activities/${w.id}`} className="block truncate text-sm font-medium text-fg hover:text-accent-fg hover:underline">
                        {workoutTitle(w, lang)}
                      </Link>
                      <div className="flex min-w-0 items-center gap-x-1 text-xs text-fg-3">
                        <span className="shrink-0">{fmt.time(w.startTs, w.tzMin)}</span>
                        {w.place && (
                          <>
                            <span aria-hidden>·</span>
                            <PlaceText w={w} size={11} />
                          </>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-sm tabular text-fg-2">
                      {w.distanceM ? <div>{fmt.distance(w.distanceM)}</div> : null}
                      <div className={w.distanceM ? 'text-xs text-fg-3' : ''}>{fmt.duration(w.durationS)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="min-w-0 space-y-4">
            {d.rings && (
              <div className="flex items-center gap-4">
                <RingGlyph
                  move={d.rings.move}
                  exercise={d.rings.exercise}
                  stand={d.rings.stand}
                  size={76}
                  label={t('consistency.rings.title')}
                />
                <KeyValues className="flex-1" items={ringRows(fmt, t, d.rings)} />
              </div>
            )}
            {health.length > 0 ? (
              <div>
                <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-3">
                  <HeartPulse size={14} aria-hidden />
                  {t('consistency.day.health')}
                </h3>
                <KeyValues items={health} />
              </div>
            ) : (
              !d.rings && <p className="text-sm text-fg-3">{t('consistency.day.noHealth')}</p>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
