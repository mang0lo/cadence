import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Moon } from 'lucide-react';
import { Link } from 'react-router';
import { mean, type HealthSettings, type SleepNight } from '@cadence/shared';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  FilterBar,
  Page,
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
  Stat,
  StatRow,
  Table,
  TD,
  TH,
} from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { useStoredState } from '@/lib/storage';
import { addDays } from '@/lib/time';
import { TrendDelta } from '../components/TrendDelta';
import { NightDetail } from '../components/sleep/NightDetail';
import { DurationChart, ScheduleChart, StagesChart } from '../components/sleep/SleepCharts';
import { useHealthMeta } from '../lib/hooks';
import { scheduleStats, tracked, wrapMinutes } from '../lib/sleep';

const SPANS = [30, 90, 180] as const;
const GOAL_OPTIONS = Array.from({ length: 9 }, (_, i) => 360 + i * 30); // 6 h … 10 h

function avgOf(nights: SleepNight[], f: (n: SleepNight) => number | null): number | null {
  return mean(nights.flatMap((n) => {
    const v = f(n);
    return v === null ? [] : [v];
  }));
}

export default function SleepPage() {
  const t = useT();
  const fmt = useFormat();
  const qc = useQueryClient();
  const meta = useHealthMeta();
  const { settings } = useSettings();
  const [span, setSpan] = useStoredState<number>('health.sleep.span', 90);
  const [selected, setSelected] = useState<string | null>(null);

  const asOf = meta.data?.asOf ?? null;
  const goalMin = meta.data?.sleepGoalMin ?? 480;
  const hasSleep = (meta.data?.sleepNights ?? 0) > 0;
  const fromDay = asOf ? addDays(asOf, -(span * 2 - 1)) : undefined;
  const nightsQ = useApi<SleepNight[]>(
    ['health', 'sleep', 'nights'],
    '/health/sleep/nights',
    { fromDay, toDay: asOf ?? undefined, kind: 'all' },
    { enabled: !!asOf && hasSleep },
  );

  const { current, previous, main, naps } = useMemo(() => {
    const list = nightsQ.data ?? [];
    const lo = asOf ? addDays(asOf, -(span - 1)) : '';
    const cur = list.filter((n) => n.day >= lo);
    const prev = list.filter((n) => n.day < lo);
    return {
      current: cur,
      previous: prev.filter((n) => n.kind === 'night'),
      main: cur.filter((n) => n.kind === 'night'),
      naps: cur.filter((n) => n.kind === 'nap'),
    };
  }, [nightsQ.data, asOf, span]);

  const trackedNow = useMemo(() => tracked(main), [main]);
  const trackedPrev = useMemo(() => tracked(previous), [previous]);
  const day = selected ?? main[main.length - 1]?.day ?? null;

  const stats = useMemo(() => {
    const asleep = avgOf(trackedNow, (n) => n.asleepS);
    const asleepPrev = avgOf(trackedPrev, (n) => n.asleepS);
    const eff = avgOf(trackedNow, (n) => n.efficiency);
    const effPrev = avgOf(trackedPrev, (n) => n.efficiency);
    // nights without real times (COROS totals) say nothing about the schedule
    const sched = scheduleStats(main.filter((n) => n.timed));
    const schedPrev = scheduleStats(previous.filter((n) => n.timed));
    return {
      asleep,
      asleepPrev,
      eff,
      effPrev,
      deep: avgOf(trackedNow, (n) => (n.staged ? n.deepS : null)),
      rem: avgOf(trackedNow, (n) => (n.staged ? n.remS : null)),
      sched,
      schedPrev,
      goalMet: trackedNow.filter((n) => n.asleepS >= goalMin * 60).length,
    };
  }, [trackedNow, trackedPrev, main, previous, goalMin]);

  const setGoal = async (minutes: number) => {
    await api.put<HealthSettings>('/health/settings', { sleepGoalMin: minutes });
    await qc.invalidateQueries({ queryKey: ['health'] });
  };

  const clock = (offsetMin: number | null) => (offsetMin === null ? '–' : fmt.time(wrapMinutes(offsetMin) * 60, 0));
  const sdText = (sd: number | null) => (sd === null ? undefined : t('health.sleep.stats.sd', { min: fmt.int(sd) }));

  const asleepDelta =
    stats.asleep !== null && stats.asleepPrev !== null ? Math.round((stats.asleep - stats.asleepPrev) / 60) : null;
  const effDelta =
    stats.eff !== null && stats.effPrev !== null ? Math.round((stats.eff - stats.effPrev) * 1000) / 10 : null;

  const goalOptions = GOAL_OPTIONS.includes(goalMin) ? GOAL_OPTIONS : [...GOAL_OPTIONS, goalMin].sort((a, b) => a - b);

  return (
    <Page>
      <PageHeader
        title={t('health.titles.SleepPage')}
        subtitle={t('health.sleep.subtitle')}
        icon={Moon}
        actions={
          hasSleep && (
            <label className="flex items-center gap-2 text-xs font-medium text-fg-3">
              {t('health.sleep.goal.label')}
              <Select
                value={String(goalMin)}
                onChange={(v) => void setGoal(Number(v))}
                options={goalOptions.map((m) => ({ value: String(m), label: fmt.durationShort(m * 60) }))}
                aria-label={t('health.sleep.goal.label')}
                className="h-8 text-xs"
              />
            </label>
          )
        }
      >
        {hasSleep && (
          <FilterBar>
            <SegmentedControl
              label={t('health.sleep.span.label')}
              value={String(span)}
              onChange={(v) => setSpan(Number(v))}
              items={SPANS.map((s) => ({ value: String(s), label: t(`health.sleep.span.n${s}`) }))}
            />
          </FilterBar>
        )}
      </PageHeader>

      {(meta.error || nightsQ.error) && <ErrorState error={meta.error ?? nightsQ.error} className="mb-4" />}

      {meta.data && !hasSleep && (
        <Card>
          <EmptyState
            icon={Moon}
            title={t('health.sleep.empty.title')}
            description={t(settings.watch === 'coros' ? 'health.sleep.empty.coros' : 'health.sleep.empty.description')}
            action={
              <Link to="/import">
                <Button>{t('common.importNow')}</Button>
              </Link>
            }
          />
        </Card>
      )}

      {hasSleep && (
        <div className="space-y-4">
          <Card>
            {!nightsQ.data ? (
              <Skeleton className="h-[72px] w-full" />
            ) : trackedNow.length === 0 ? (
              <p className="py-2 text-sm text-fg-3">{t('health.sleep.noTrackedNights')}</p>
            ) : (
              <StatRow>
                <Stat
                  label={t('health.sleep.stats.avgAsleep')}
                  value={stats.asleep !== null ? fmt.durationShort(stats.asleep) : '–'}
                  delta={
                    asleepDelta !== null && (
                      <TrendDelta
                        value={asleepDelta}
                        good="up"
                        text={`${asleepDelta > 0 ? '+' : asleepDelta < 0 ? '−' : '±'}${fmt.durationShort(Math.abs(asleepDelta) * 60)}`}
                      />
                    )
                  }
                  hint={asleepDelta !== null ? t('health.sleep.stats.vsPrev', { count: span }) : undefined}
                />
                <Stat
                  label={t('health.sleep.stats.efficiency')}
                  value={stats.eff !== null ? fmt.pct(stats.eff) : '–'}
                  delta={
                    effDelta !== null && (
                      <TrendDelta value={effDelta} good="up" text={`${fmt.signed(effDelta, 1)} %`} />
                    )
                  }
                  hint={effDelta !== null ? t('health.sleep.stats.vsPrev', { count: span }) : undefined}
                />
                <Stat
                  label={t('health.sleep.stats.goalMet')}
                  value={fmt.pct(trackedNow.length ? stats.goalMet / trackedNow.length : 0)}
                  hint={t('health.sleep.stats.nights', { count: stats.goalMet, total: trackedNow.length })}
                />
                <Stat
                  label={t('health.sleep.stats.avgBedtime')}
                  value={clock(stats.sched.bed)}
                  hint={sdText(stats.sched.bedSd)}
                />
                <Stat label={t('health.sleep.stats.avgWake')} value={clock(stats.sched.wake)} hint={sdText(stats.sched.wakeSd)} />
                <Stat label={t('health.sleep.stats.avgDeep')} value={stats.deep !== null ? fmt.durationShort(stats.deep) : '–'} />
                <Stat label={t('health.sleep.stats.avgRem')} value={stats.rem !== null ? fmt.durationShort(stats.rem) : '–'} />
              </StatRow>
            )}
          </Card>

          {!nightsQ.data ? (
            <>
              <Skeleton className="h-[340px] w-full" />
              <Skeleton className="h-[320px] w-full" />
            </>
          ) : (
            <>
              {trackedNow.length > 0 && <StagesChart nights={main} selectedDay={day} onSelect={setSelected} />}
              {trackedNow.length > 0 && (
                <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-2">
                  <DurationChart nights={main} goalMin={goalMin} />
                  {main.some((n) => n.timed) ? (
                    <ScheduleChart nights={main.filter((n) => n.timed)} selectedDay={day} onSelect={setSelected} />
                  ) : (
                    <Card>
                      <EmptyState icon={Moon} title={t('health.sleep.schedule.title')} description={t('health.sleep.untimed')} />
                    </Card>
                  )}
                </div>
              )}
            </>
          )}

          {day && (
            <NightDetail
              nights={main}
              day={day}
              onDayChange={setSelected}
              minDay={meta.data?.firstDay ?? undefined}
              maxDay={asOf ?? undefined}
            />
          )}

          {naps.length > 0 && (
            <Card>
              <CardHeader title={t('health.sleep.naps.title')} subtitle={t('health.sleep.naps.subtitle')} />
              <Table className="max-h-72">
                <thead>
                  <tr>
                    <TH>{t('health.sleep.table.date')}</TH>
                    <TH>{t('health.sleep.naps.time')}</TH>
                    <TH numeric>{t('health.sleep.table.asleep')}</TH>
                  </tr>
                </thead>
                <tbody>
                  {[...naps].reverse().map((n) => (
                    <tr key={n.id}>
                      <TD>{fmt.day(n.day, 'weekdayShort')}</TD>
                      <TD>
                        {fmt.time(n.bedTs, n.tzBedMin)} – {fmt.time(n.wakeTs, n.tzWakeMin)}
                      </TD>
                      <TD numeric>{fmt.durationShort(n.asleepS)}</TD>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
        </div>
      )}
    </Page>
  );
}
