import { Link, useNavigate, useParams } from 'react-router';
import {
  CalendarCheck,
  Clock,
  Flag,
  Flame,
  HeartPulse,
  Mountain,
  Rocket,
  Sparkles,
  Timer,
  Trophy,
  Zap,
} from 'lucide-react';
import { workoutTitle, type YearReview } from '@cadence/shared';
import { Card, CardHeader, Delta, EmptyState, ErrorState, Page, PageHeader, Skeleton, Table, TD, TH, cn } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { SportIcon } from '@/lib/sports';
import { useYearReview } from '../api';
import { reviewWeeks } from '../lib';
import { NoActivities } from '../components/AsOfNote';
import { achievementIcon, Medallion } from '../components/Medallion';
import { achievementTitle } from '../components/TrophyParts';
import { YearSwitcher } from '../components/YearSwitcher';
import {
  effortLabel,
  effortPace,
  HighlightCard,
  MonthsChart,
  PctDelta,
  prevPartial,
  PrBadge,
  RhythmChart,
  SportBars,
  YearHero,
} from '../components/YearParts';

const EVEREST_M = 8848;
const EIFFEL_M = 330;

function Section({ title, icon, children, className }: { title: string; icon?: typeof Trophy; children: React.ReactNode; className?: string }) {
  return (
    <Card className={cn('min-w-0', className)}>
      <CardHeader title={title} icon={icon} />
      {children}
    </Card>
  );
}

function BigStat({ label, value, unit, hint }: { label: string; value: string; unit?: string; hint?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-xs font-medium text-fg-3">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className="text-2xl font-semibold tracking-tight text-fg">{value}</span>
        {unit && <span className="text-sm text-fg-3">{unit}</span>}
      </div>
      {hint && <div className="mt-0.5 text-xs text-fg-3">{hint}</div>}
    </div>
  );
}

function Health({ r }: { r: YearReview }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const h = r.health;
  const totalsComparable = !prevPartial(r);
  const items: { label: string; value: string; delta?: React.ReactNode }[] = [];
  const delta = (cur: number | null, prev: number | null, upIsGood: boolean, text: (d: number) => string) =>
    cur !== null && prev !== null ? <Delta value={Math.abs(cur - prev) < 0.05 ? 0 : cur - prev} upIsGood={upIsGood} text={text(cur - prev)} /> : null;
  if (h.restingHr.value !== null)
    items.push({
      label: t('consistency.year.health.restingHr'),
      value: fmt.hr(h.restingHr.value),
      delta: delta(h.restingHr.value, h.restingHr.prev, false, (d) => `${fmt.signed(d, 1)} bpm`),
    });
  if (h.hrv.value !== null)
    items.push({
      label: t('consistency.year.health.hrv'),
      value: `${fmt.int(h.hrv.value)} ms`,
      delta: delta(h.hrv.value, h.hrv.prev, true, (d) => `${fmt.signed(d, 1)} ms`),
    });
  if (h.vo2max.value !== null)
    items.push({
      label: t('consistency.year.health.vo2max'),
      value: fmt.num(h.vo2max.value, 1),
      delta: delta(h.vo2max.value, h.vo2max.prev, true, (d) => fmt.signed(d, 1)),
    });
  if (h.stepsPerDay.value !== null)
    items.push({
      label: t('consistency.year.health.steps'),
      value: fmt.int(h.stepsPerDay.value),
      delta: <PctDelta cur={h.stepsPerDay.value} prev={h.stepsPerDay.prev} />,
    });
  if (h.sleepPerNightMin.value !== null)
    items.push({
      label: t('consistency.year.health.sleep'),
      value: fmt.durationShort(h.sleepPerNightMin.value * 60),
      delta:
        h.sleepPerNightMin.prev !== null ? (
          <Delta
            value={Math.round(h.sleepPerNightMin.value - h.sleepPerNightMin.prev)}
            upIsGood
            text={(() => {
              const d = Math.round(h.sleepPerNightMin.value - h.sleepPerNightMin.prev);
              return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${d ? fmt.durationShort(Math.abs(d) * 60) : t('consistency.goals.zeroTime')}`;
            })()}
          />
        ) : null,
    });
  if (h.activeEnergyKcal.value !== null)
    items.push({
      label: t('consistency.year.health.activeEnergy'),
      value: fmt.energy(h.activeEnergyKcal.value),
      delta: totalsComparable ? <PctDelta cur={h.activeEnergyKcal.value} prev={h.activeEnergyKcal.prev} /> : null,
    });
  if (h.flights.value !== null)
    items.push({
      label: t('consistency.year.health.flights'),
      value: fmt.int(h.flights.value),
      delta: totalsComparable ? <PctDelta cur={h.flights.value} prev={h.flights.prev} /> : null,
    });
  if (h.weightStart !== null && h.weightEnd !== null)
    items.push({
      label: t('consistency.year.health.weight'),
      value: `${fmt.weight(h.weightStart)} → ${fmt.weight(h.weightEnd)}`,
    });
  if (!items.length) return null;
  return (
    <Section title={t('consistency.year.healthTitle')} icon={HeartPulse}>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        {items.map((x) => (
          <BigStat key={x.label} label={x.label} value={x.value} hint={x.delta} />
        ))}
      </div>
      <p className="mt-4 text-xs text-fg-3">
        {t('consistency.year.healthNote', { year: r.year - 1 })}
        {h.bestStepsDay && ` · ${t('consistency.year.bestSteps', { steps: fmt.int(h.bestStepsDay.value), date: fmt.day(h.bestStepsDay.day, 'dayShort') })}`}
      </p>
    </Section>
  );
}

function Comparison({ r }: { r: YearReview }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const p = r.previous;
  if (!p) return null;
  const comparable = !prevPartial(r);
  const rows: { label: string; prev: number; cur: number; show: (v: number) => string }[] = [
    { label: t('consistency.year.activities'), prev: p.activities, cur: r.totals.activities, show: fmt.int },
    { label: t('consistency.year.activeDays'), prev: p.activeDays, cur: r.totals.activeDays, show: fmt.int },
    { label: t('consistency.year.hours'), prev: p.durationS, cur: r.totals.durationS, show: fmt.hours },
    { label: t('common.distance'), prev: p.distanceM, cur: r.totals.distanceM, show: (v) => fmt.distance(v, 0) },
    { label: t('common.elevation'), prev: p.elevationM, cur: r.totals.elevationM, show: fmt.elevation },
    { label: t('common.calories'), prev: p.energyKcal, cur: r.totals.energyKcal, show: fmt.energy },
    { label: t('common.effort'), prev: p.effort, cur: r.totals.effort, show: fmt.int },
  ];
  return (
    <Section
      title={r.complete ? t('consistency.year.compareTitle', { year: r.year - 1 }) : t('consistency.year.compareTitleToDate', { year: r.year - 1 })}
      icon={Zap}
    >
      <Table>
        <thead>
          <tr>
            <TH />
            <TH numeric>{r.year - 1}</TH>
            <TH numeric>{r.year}</TH>
            <TH numeric>{t('consistency.year.change')}</TH>
          </tr>
        </thead>
        <tbody>
          {rows.map((x) => (
            <tr key={x.label}>
              <TD className="font-medium text-fg">{x.label}</TD>
              <TD numeric>{x.show(x.prev)}</TD>
              <TD numeric className="font-semibold text-fg">
                {x.show(x.cur)}
              </TD>
              <TD numeric>{comparable ? <PctDelta cur={x.cur} prev={x.prev} /> : '–'}</TD>
            </tr>
          ))}
        </tbody>
      </Table>
      {!comparable && r.firstDay && (
        <p className="mt-3 text-xs text-fg-3">{t('consistency.year.prevPartial', { year: r.year - 1, date: fmt.day(r.firstDay, 'day') })}</p>
      )}
    </Section>
  );
}

function Review({ r }: { r: YearReview }) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const { settings } = useSettings();
  // weeks the data covers: the first year of data starts late, the running year ends at asOf
  const weeks = reviewWeeks(r);
  const improved = r.prs.filter((p) => p.previousBestS !== null);
  const firsts = r.prs.length - improved.length;
  const trophies = [...r.trophies].sort((a, b) => ['gold', 'silver', 'bronze'].indexOf(a.tier) - ['gold', 'silver', 'bronze'].indexOf(b.tier));
  const highlights = [
    r.longest && { icon: Flag, label: t('consistency.year.longest'), value: fmt.distance(r.longest.distanceM), w: r.longest },
    r.longestTime && { icon: Timer, label: t('consistency.year.longestTime'), value: fmt.duration(r.longestTime.durationS), w: r.longestTime },
    r.biggestClimb && { icon: Mountain, label: t('consistency.year.biggestClimb'), value: fmt.elevation(r.biggestClimb.elevationGainM), w: r.biggestClimb },
    r.first && { icon: Rocket, label: t('consistency.year.first'), value: fmt.date(r.first.startTs, r.first.tzMin, 'dayShort'), w: r.first },
  ].filter((x): x is NonNullable<typeof x> => !!x);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Section title={t('consistency.year.bySport')} icon={Sparkles}>
          <SportBars r={r} />
        </Section>
        <MonthsChart r={r} />
      </div>

      {highlights.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {highlights.map((h) => (
            <HighlightCard key={h.label} icon={h.icon} label={h.label} value={h.value} w={h.w} />
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <RhythmChart r={r} kind="weekday" weekStart={settings.weekStart} />
        <RhythmChart r={r} kind="hour" weekStart={settings.weekStart} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={t('consistency.year.streaksTitle')} icon={Flame}>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4">
            <BigStat
              label={t('consistency.year.longestDaily')}
              value={fmt.int(r.streaks.daily?.length ?? 0)}
              unit={t('consistency.common.dayUnit', { count: r.streaks.daily?.length ?? 0 })}
              hint={r.streaks.daily ? `${fmt.day(r.streaks.daily.start, 'dayShort')} – ${fmt.day(r.streaks.daily.end, 'dayShort')}` : undefined}
            />
            <BigStat
              label={t('consistency.year.longestWeekly')}
              value={fmt.int(r.streaks.weekly?.length ?? 0)}
              unit={t('consistency.common.weekUnit', { count: r.streaks.weekly?.length ?? 0 })}
              hint={r.streaks.weekly ? `${fmt.day(r.streaks.weekly.start, 'dayShort')} – ${fmt.day(r.streaks.weekly.end, 'dayShort')}` : undefined}
            />
            {r.rings && (
              <>
                <BigStat
                  label={t('consistency.year.moveClosed')}
                  value={fmt.int(r.rings.move)}
                  unit={t('consistency.common.dayUnit', { count: r.rings.move })}
                  hint={t('consistency.year.ofDays', { pct: fmt.pct(r.rings.move / r.rings.days), count: r.rings.days })}
                />
                <BigStat
                  label={t('consistency.year.allClosed')}
                  value={fmt.int(r.rings.all)}
                  unit={t('consistency.common.dayUnit', { count: r.rings.all })}
                  hint={`${t('consistency.rings.exercise')} ${fmt.int(r.rings.exercise)} · ${t('consistency.rings.stand')} ${fmt.int(r.rings.stand)}`}
                />
              </>
            )}
          </div>
        </Section>
        <Section title={t('consistency.year.timeTitle')} icon={Clock}>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4">
            <BigStat label={t('consistency.year.hours')} value={fmt.int(r.totals.durationS / 3600)} unit="h" hint={t('consistency.year.fullDays', { count: Math.round(r.totals.durationS / 86400) })} />
            <BigStat label={t('consistency.year.perWeek')} value={fmt.durationShort(r.totals.durationS / weeks)} />
            <BigStat
              label={t('common.elevation')}
              value={fmt.elevation(r.totals.elevationM)}
              hint={t('consistency.year.everest', { x: fmt.num(r.totals.elevationM / EVEREST_M, 1) })}
            />
            <BigStat
              label={t('consistency.year.eiffel')}
              value={`${fmt.int(r.totals.elevationM / EIFFEL_M)} ×`}
              hint={t('consistency.year.eiffelHint', { height: fmt.elevation(EIFFEL_M) })}
            />
          </div>
        </Section>
      </div>

      {(r.fastest.length > 0 || improved.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          {r.fastest.length > 0 && (
            <Section title={t('consistency.year.fastest')} icon={Zap}>
              <ul className="divide-y divide-border">
                {r.fastest.map((f) => (
                  <li key={`${f.sport}-${f.effort}`} className="flex items-center gap-3 py-2">
                    <SportIcon sport={f.sport} size={16} className="shrink-0 text-fg-3" />
                    <span className="w-28 shrink-0 text-sm font-medium text-fg">{effortLabel(f.sport, f.effort, lang)}</span>
                    <span className="text-sm font-semibold tabular text-fg">{fmt.duration(f.elapsedS)}</span>
                    <span className="hidden whitespace-nowrap text-xs text-fg-3 xl:inline">{effortPace(fmt, f.sport, f.distanceM, f.elapsedS)}</span>
                    <span className="ml-auto flex min-w-0 items-center gap-2">
                      {f.improvements > 0 && <PrBadge />}
                      <Link to={`/activities/${f.workout.id}`} className="truncate text-xs text-fg-3 hover:text-fg hover:underline">
                        {fmt.date(f.workout.startTs, f.workout.tzMin, 'dayShort')}
                      </Link>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section title={t('consistency.year.prs')} icon={Trophy}>
            {improved.length === 0 ? (
              <p className="text-sm text-fg-3">{t('consistency.year.noPrs')}</p>
            ) : (
              <ul className="divide-y divide-border">
                {improved.map((p) => (
                  <li key={`${p.sport}-${p.effort}`} className="flex items-center gap-3 py-2">
                    <SportIcon sport={p.sport} size={16} className="shrink-0 text-fg-3" />
                    <span className="w-28 shrink-0 text-sm font-medium text-fg">{effortLabel(p.sport, p.effort, lang)}</span>
                    <span className="text-sm font-semibold tabular text-fg">{fmt.duration(p.elapsedS)}</span>
                    <Delta value={p.elapsedS - p.previousBestS!} upIsGood={false} text={`−${fmt.duration(p.previousBestS! - p.elapsedS)}`} />
                    <Link to={`/activities/${p.workout.id}`} className="ml-auto truncate text-xs text-fg-3 hover:text-fg hover:underline">
                      {workoutTitle(p.workout, lang)}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {firsts > 0 && <p className="mt-3 text-xs text-fg-3">{t('consistency.year.firstDistances', { count: firsts })}</p>}
          </Section>
        </div>
      )}

      {trophies.length > 0 && (
        <Section title={t('consistency.year.trophies', { count: trophies.length })} icon={Trophy}>
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
            {trophies.slice(0, 9).map((a) => (
              <div key={a.key} className="flex min-w-0 items-center gap-3">
                <Medallion tier={a.tier} icon={achievementIcon(a)} size={40} label={t(`consistency.trophies.tiers.${a.tier}`)} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-fg">{achievementTitle(a, t, fmt, lang)}</div>
                  <div className="text-xs text-fg-3">{fmt.day(a.earnedDay!, 'day')}</div>
                </div>
              </div>
            ))}
          </div>
          {trophies.length > 9 && (
            <Link to="/trophies" className="mt-3 inline-block text-xs font-medium text-accent-fg hover:underline">
              {t('consistency.year.moreTrophies', { count: trophies.length - 9 })}
            </Link>
          )}
        </Section>
      )}

      <Health r={r} />
      <Comparison r={r} />
    </div>
  );
}

export default function YearInReviewPage() {
  const { t } = useI18n();
  const params = useParams();
  const navigate = useNavigate();
  const wanted = params.year && /^\d{4}$/.test(params.year) ? Number(params.year) : null;
  const q = useYearReview(wanted);
  const r = q.data;
  const switching = q.isFetching && !!r && wanted !== null && r.year !== wanted;

  return (
    <Page>
      <div className="mx-auto max-w-6xl">
      <PageHeader
        title={t('consistency.year.title')}
        subtitle={t('consistency.year.subtitle')}
        icon={CalendarCheck}
        actions={r && <YearSwitcher year={wanted ?? r.year} years={r.years} onChange={(y) => navigate(`/year/${y}`)} />}
      />
      {q.error ? (
        <ErrorState error={q.error} />
      ) : !r ? (
        <div className="space-y-4">
          <Skeleton className="h-72 rounded-card" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-64 rounded-card" />
            <Skeleton className="h-64 rounded-card" />
          </div>
        </div>
      ) : (
        <div className={cn('space-y-4 transition-opacity', switching && 'opacity-50')}>
          <YearHero r={r} />
          {r.totals.activities === 0 ? (
            <Card>
              {r.firstDay ? (
                <EmptyState icon={CalendarCheck} title={t('consistency.year.empty', { year: r.year })} />
              ) : (
                <NoActivities />
              )}
            </Card>
          ) : (
            <Review r={r} />
          )}
        </div>
      )}
      </div>
    </Page>
  );
}
