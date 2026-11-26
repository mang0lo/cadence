import { useMemo } from 'react';
import { BatteryCharging, Info, ListChecks, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router';
import { READINESS_FACTORS, type ReadinessDay, type ReadinessModelInfo } from '@cadence/shared';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  FilterBar,
  KeyValues,
  Page,
  PageHeader,
  SegmentedControl,
  Skeleton,
  cn,
} from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useStoredState } from '@/lib/storage';
import { DayNav } from '../components/DayNav';
import { useDayLabel } from '../components/MetricCard';
import { FactorList } from '../components/readiness/FactorList';
import { HrvBaselineChart, ReadinessTrendChart, RestingHrBaselineChart } from '../components/readiness/ReadinessCharts';
import { ReadinessBandBadge, ReadinessRing, ReasonList } from '../components/readiness/ReadinessRing';
import { useDayParam, useHealthMeta } from '../lib/hooks';
import { useReadiness, useReadinessFormat } from '../lib/readiness';

const SPANS = [30, 90] as const;
/** Always fetched; the 30-day view is a slice of it (no refetch when switching). */
const HISTORY_DAYS = 90;

/** Score ring, band, advice and the main reasons of the day – or what is missing for a score. */
function DayCard({ day, model, dim }: { day: ReadinessDay; model: ReadinessModelInfo; dim?: boolean }) {
  const t = useT();
  const fmt = useFormat();
  const rf = useReadinessFormat();
  const dayLabel = useDayLabel();
  const used = day.factors.filter((f) => f.used).length;
  return (
    <Card className={cn('@container', dim && 'opacity-70 transition-opacity')}>
      <CardHeader title={dayLabel(day.day)} subtitle={fmt.day(day.day, 'weekday')} icon={BatteryCharging} />
      {day.score !== null && day.band ? (
        <div className="flex flex-col items-center gap-5 @md:flex-row">
          <ReadinessRing score={day.score} band={day.band} size={148} />
          <div className="flex min-w-0 flex-1 flex-col items-center @md:items-start">
            <ReadinessBandBadge band={day.band} />
            <p className="mt-2 text-center text-sm text-fg @md:text-left">{t(`health.readiness.advice.${day.band}`)}</p>
            {day.cappedBy && (
              <p className="mt-1.5 text-center text-xs text-fg-2 @md:text-left">
                {t('health.readiness.cappedNote', { band: rf.band('easy'), factor: rf.name(day.cappedBy) })}
              </p>
            )}
            <ReasonList day={day} className="mt-3 w-fit" />
            <p className="mt-3 text-xs text-fg-3">
              {t('health.readiness.coverage', { used, total: READINESS_FACTORS.length })}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-control bg-surface-2 px-4 py-3">
          <Info size={18} className="mt-0.5 shrink-0 text-fg-3" aria-hidden />
          <div>
            <div className="text-sm font-medium text-fg">{t('health.readiness.insufficient.title')}</div>
            <p className="mt-0.5 text-xs text-fg-3">
              {t(`health.readiness.insufficient.${day.insufficient ?? 'noCore'}`, { min: model.minBaselineDays })}
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}

function HowItWorks({ model }: { model: ReadinessModelInfo }) {
  const t = useT();
  const fmt = useFormat();
  const rf = useReadinessFormat();
  const k = (key: string, vars?: Record<string, string | number>) => t(`health.readiness.how.${key}`, vars);
  return (
    <Card>
      <CardHeader title={k('title')} icon={ListChecks} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="space-y-2.5 text-sm text-fg-2">
          <p>{k('baseline', { days: model.baselineDays })}</p>
          <p>{k('signals', { hrvDays: model.hrvDays, atlDays: model.atlDays, ctlDays: model.ctlDays })}</p>
          <p>{k('points')}</p>
          <p>{k('conservative', { min: model.minBaselineDays, band: rf.band('easy') })}</p>
        </div>
        <div className="space-y-5">
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-fg-3">{k('weights')}</h3>
            <KeyValues items={READINESS_FACTORS.map((f) => [rf.name(f), fmt.pct(model.weights[f] / 100)])} />
          </section>
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-fg-3">{k('bandsTitle')}</h3>
            <ul className="space-y-1.5">
              {model.bands.map((b, i) => (
                <li key={b.key} className="flex items-center justify-between gap-3 text-sm">
                  <ReadinessBandBadge band={b.key} />
                  <span className="font-medium text-fg tabular">
                    {i === 0 ? k('bandFrom', { min: b.min }) : k('bandRange', { min: b.min, max: model.bands[i - 1]!.min - 1 })}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
      <div className="mt-5 flex items-start gap-2.5 rounded-control bg-surface-2 px-3.5 py-3 text-xs text-fg-2">
        <ShieldAlert size={16} className="mt-px shrink-0 text-fg-3" aria-hidden />
        <p>{t('health.readiness.disclaimer')}</p>
      </div>
    </Card>
  );
}

export default function ReadinessPage() {
  const t = useT();
  const meta = useHealthMeta();
  const [span, setSpan] = useStoredState<number>('health.readiness.span', 90);
  const asOf = meta.data?.asOf ?? null;
  // the evaluated day lives in the URL (?day=, default: the latest day with data) so a day can be linked; the
  // requested day wins over the day of the answer, which stays the previous one until the new day has loaded
  const { day, picked, setDay } = useDayParam(asOf);
  const ready = !!asOf;
  const q = useReadiness(picked ?? undefined, HISTORY_DAYS, ready);
  const data = q.data;
  const shown = (SPANS as readonly number[]).includes(span) ? span : 90;
  const firstDay = meta.data?.firstDay ?? null;
  // no empty stretch before the data starts
  const history = useMemo(
    () => (data?.history ?? []).slice(-shown).filter((h) => !firstDay || h.day >= firstDay),
    [data, shown, firstDay],
  );
  const current = data?.current ?? null;
  const fetching = q.isFetching && !q.isLoading;

  return (
    <Page>
      <PageHeader title={t('health.titles.ReadinessPage')} subtitle={t('health.readiness.subtitle')} icon={BatteryCharging}>
        {ready && day && (
          <FilterBar>
            <DayNav
              day={day}
              onChange={setDay}
              min={meta.data?.firstDay ?? undefined}
              max={asOf ?? undefined}
              prevLabel={t('health.readiness.day.prev')}
              nextLabel={t('health.readiness.day.next')}
              pickLabel={t('health.readiness.day.pick')}
            />
            <SegmentedControl
              label={t('health.readiness.span.label')}
              value={String(shown)}
              onChange={(v) => setSpan(Number(v))}
              items={SPANS.map((s) => ({ value: String(s), label: t(`health.readiness.span.n${s}`) }))}
            />
          </FilterBar>
        )}
      </PageHeader>

      {(meta.error || q.error) && <ErrorState error={meta.error ?? q.error} className="mb-4" />}

      {meta.data && !ready && (
        <Card>
          <EmptyState
            icon={BatteryCharging}
            title={t('health.noData.title')}
            description={t('health.noData.description')}
            action={
              <Link to="/import">
                <Button>{t('common.importNow')}</Button>
              </Link>
            }
          />
        </Card>
      )}

      {ready && (
        <div className="space-y-4">
          <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
            {current && data ? (
              <DayCard day={current} model={data.model} dim={fetching} />
            ) : (
              <Skeleton className="h-[264px] w-full rounded-card" />
            )}
            {current && data ? (
              <Card className={fetching ? 'opacity-70 transition-opacity' : undefined}>
                <CardHeader
                  title={t('health.readiness.factors.title')}
                  subtitle={t('health.readiness.factors.subtitle', { days: data.model.baselineDays })}
                />
                <FactorList day={current} model={data.model} />
              </Card>
            ) : (
              <Skeleton className="h-[420px] w-full rounded-card" />
            )}
          </div>

          {data ? (
            <>
              <ReadinessTrendChart history={history} model={data.model} loading={fetching} />
              <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-2">
                <HrvBaselineChart history={history} hrvDays={data.model.hrvDays} loading={fetching} />
                <RestingHrBaselineChart history={history} loading={fetching} />
              </div>
              <HowItWorks model={data.model} />
            </>
          ) : (
            <Skeleton className="h-[300px] w-full rounded-card" />
          )}
        </div>
      )}
    </Page>
  );
}
