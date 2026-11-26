import { useState } from 'react';
import { ChevronLeft, Database } from 'lucide-react';
import { Link, useParams } from 'react-router';
import {
  HEALTH_CATEGORIES,
  metricCategory,
  type MetricAgg,
  type MetricSeries,
} from '@cadence/shared';
import { useChartTheme } from '@/components/charts/theme';
import { Badge, Button, Card, ErrorState, FilterBar, Page, PageHeader, SegmentedControl, Skeleton, Stat, StatRow } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useI18n, useT } from '@/lib/i18n';
import { diffDays } from '@/lib/time';
import { DayNav } from '../components/DayNav';
import { IntradayChart } from '../components/IntradayChart';
import { useDayLabel } from '../components/MetricCard';
import { RangeSelect } from '../components/RangeSelect';
import { MetricChart, type MetricMode } from '../components/metric/MetricChart';
import { SamplesCard } from '../components/metric/SamplesCard';
import { SourcesCard } from '../components/metric/SourcesCard';
import { identifierColor } from '../lib/colors';
import { useRange } from '../lib/hooks';
import { useMetricFormat } from '../lib/metrics';

/** Sensible default grouping for the length of the range. */
function autoAgg(days: number | null): MetricAgg {
  if (days === null) return 'month';
  if (days <= 120) return 'day';
  return days <= 800 ? 'week' : 'month';
}

export default function MetricPage() {
  const { type = '' } = useParams();
  const t = useT();
  const fmt = useFormat();
  const m = useMetricFormat();
  const { lang } = useI18n();
  const theme = useChartTheme();
  const dayLabel = useDayLabel();
  const { range, setRange, fromDay, toDay, days, meta } = useRange('metric', '1y');
  const [aggPref, setAggPref] = useState<MetricAgg | null>(null);
  const [mode, setMode] = useState<MetricMode>('average');
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const agg = aggPref ?? autoAgg(days);
  // the whole history needs no day filter (and no row count over millions of records)
  const listFrom = range === 'all' ? undefined : fromDay;
  const listTo = range === 'all' ? undefined : toDay;
  const ready = !!meta.data?.asOf && !!type;

  const q = useApi<MetricSeries>(['health', 'metric', 'series'], ready ? '/health/metric/series' : null, { type, fromDay, toDay, agg });
  const s = q.data && q.data.type.identifier.endsWith(type) ? q.data : null;
  const info = s?.type ?? null;
  const identifier = info?.identifier ?? type;
  const name = m.name(identifier);
  const category = metricCategory(identifier);
  const catLabel = HEALTH_CATEGORIES.find((c) => c.key === category)?.[lang] ?? '';

  const cumulative = info ? info.aggregation !== 'avg' : false;
  const isEvent = !!s && info?.kind === 'category' && s.categories.length > 0 && s.categories.every((c) => c.total === 0);
  const unit = info?.unit ?? null;
  const intradayDay = pickedDay ?? s?.stats.latestDay ?? meta.data?.asOf ?? null;

  const stats = s?.stats;
  const parts = (v: number | null | undefined) => m.parts(identifier, v ?? undefined, unit);
  // events per calendar day of the range (per day that had an event would be about 1)
  const rangeDays = s?.fromDay && s.toDay ? diffDays(s.fromDay, s.toDay) + 1 : 0;
  const eventsPerDay = stats && rangeDays > 0 ? stats.samples / rangeDays : 0;

  return (
    <Page>
      <PageHeader
        title={name}
        icon={Database}
        subtitle={
          info && info.firstTs !== null && info.lastTs !== null
            ? `${identifier} · ${t('health.metric.typeInfo', {
                count: fmt.int(info.count),
                from: fmt.browserDate(info.firstTs, 'day'),
                to: fmt.browserDate(info.lastTs, 'day'),
              })}`
            : identifier
        }
        actions={
          <Link to="/health/explorer">
            <Button size="sm" icon={ChevronLeft}>
              {t('health.metric.all')}
            </Button>
          </Link>
        }
      >
        <FilterBar>
          <Badge tone="accent">{catLabel}</Badge>
          <RangeSelect
            value={range}
            onChange={(r) => {
              setRange(r);
              setAggPref(null);
            }}
          />
          <SegmentedControl
            label={t('health.metric.agg.label')}
            value={agg}
            onChange={setAggPref}
            items={(['day', 'week', 'month'] as const).map((a) => ({ value: a, label: t(`health.metric.agg.${a}`) }))}
          />
          {cumulative && agg !== 'day' && !isEvent && (
            <SegmentedControl
              label={t('health.metric.mode.label')}
              value={mode}
              onChange={setMode}
              items={[
                { value: 'average', label: t('health.metric.mode.average') },
                { value: 'total', label: t('health.metric.mode.total') },
              ]}
            />
          )}
        </FilterBar>
      </PageHeader>

      {(meta.error || q.error) && (
        <div className="mb-4 space-y-3">
          <ErrorState error={q.error?.status === 404 ? new Error(t('health.metric.notFound')) : (meta.error ?? q.error)} />
        </div>
      )}

      {ready && !q.error && (
        <div className="space-y-4">
          <Card>
            {!stats ? (
              <Skeleton className="h-[72px] w-full" />
            ) : (
              <StatRow>
                {cumulative ? (
                  <>
                    <Stat
                      size="sm"
                      label={t('health.metric.stats.total')}
                      value={isEvent ? fmt.int(stats.samples) : parts(stats.total).value}
                      unit={isEvent ? t('health.metric.stats.events') : parts(stats.total).unit}
                    />
                    <Stat
                      size="sm"
                      label={`${t('health.metric.stats.average')} (${t('health.metric.stats.perDay')})`}
                      value={isEvent ? fmt.num(eventsPerDay, eventsPerDay > 0 && eventsPerDay < 1 ? 2 : 1) : parts(stats.mean).value}
                      unit={isEvent ? '' : parts(stats.mean).unit}
                    />
                    {!isEvent && <Stat size="sm" label={t('health.metric.stats.median')} value={parts(stats.median).value} unit={parts(stats.median).unit} />}
                    {!isEvent && <Stat size="sm" label={t('health.metric.stats.min')} value={parts(stats.min).value} unit={parts(stats.min).unit} />}
                    {!isEvent && <Stat size="sm" label={t('health.metric.stats.max')} value={parts(stats.max).value} unit={parts(stats.max).unit} />}
                    <Stat
                      size="sm"
                      label={t('health.metric.stats.latest')}
                      value={isEvent ? dayLabel(stats.latestDay) || '–' : parts(stats.latest).value}
                      unit={isEvent ? '' : parts(stats.latest).unit}
                      hint={isEvent ? undefined : dayLabel(stats.latestDay)}
                    />
                  </>
                ) : (
                  <>
                    <Stat size="sm" label={t('health.metric.stats.latest')} value={parts(stats.latest).value} unit={parts(stats.latest).unit} hint={dayLabel(stats.latestDay)} />
                    <Stat size="sm" label={t('health.metric.stats.average')} value={parts(stats.mean).value} unit={parts(stats.mean).unit} />
                    <Stat size="sm" label={t('health.metric.stats.median')} value={parts(stats.median).value} unit={parts(stats.median).unit} />
                    <Stat size="sm" label={t('health.metric.stats.min')} value={parts(stats.min).value} unit={parts(stats.min).unit} />
                    <Stat size="sm" label={t('health.metric.stats.max')} value={parts(stats.max).value} unit={parts(stats.max).unit} />
                  </>
                )}
                <Stat size="sm" label={t('health.metric.stats.daysWithData')} value={fmt.int(stats.days)} />
                {info?.aggregation === 'avg' && <Stat size="sm" label={t('health.metric.stats.samples')} value={fmt.int(stats.samples)} />}
              </StatRow>
            )}
          </Card>

          {s ? <MetricChart series={s} mode={mode} loading={q.isFetching} /> : <Skeleton className="h-[360px] w-full" />}

          {info?.kind === 'quantity' && intradayDay && meta.data && (
            <IntradayChart
              key={identifier}
              type={identifier}
              unit={unit}
              day={intradayDay}
              title={t('health.metric.intraday.title')}
              subtitle={`${fmt.day(intradayDay, 'weekday')} · ${t('health.metric.intraday.subtitle')}`}
              color={identifierColor(theme, identifier)}
              workouts
              actions={
                <DayNav
                  day={intradayDay}
                  onChange={setPickedDay}
                  min={meta.data.firstDay ?? undefined}
                  max={meta.data.asOf ?? undefined}
                  prevLabel={t('health.metric.intraday.prev')}
                  nextLabel={t('health.metric.intraday.next')}
                  pickLabel={t('health.metric.intraday.pick')}
                />
              }
            />
          )}

          {info && <SourcesCard key={`src-${identifier}`} type={identifier} fromDay={listFrom} toDay={listTo} />}
          {info && <SamplesCard key={`smp-${identifier}`} type={info} fromDay={listFrom} toDay={listTo} />}
        </div>
      )}
    </Page>
  );
}
