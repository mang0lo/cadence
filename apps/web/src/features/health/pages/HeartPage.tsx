import { useMemo, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Gauge,
  Heart,
  HeartPulse,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import { shiftDay, type HeartEvent, type HeartEventType } from '@cadence/shared';
import { useChartTheme } from '@/components/charts/theme';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  FilterBar,
  Page,
  PageHeader,
  Stat,
  Table,
  TD,
  TH,
} from '@/components/ui';
import { useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useHasMetric } from '@/lib/sources';
import { DayNav } from '../components/DayNav';
import { IntradayChart } from '../components/IntradayChart';
import { RangeSelect } from '../components/RangeSelect';
import { TrendChart } from '../components/TrendChart';
import { measureColor } from '../lib/colors';
import { useDaily, useHeartMetrics, useRange } from '../lib/hooks';
import { HK } from '../lib/identifiers';
import { useMetricFormat } from '../lib/metrics';
import { toPoints } from '../lib/series';

const WHR = HK.walkingHr;
const REC = HK.recovery;

const EVENT_ICON: Record<HeartEventType, LucideIcon> = {
  high: TrendingUp,
  low: TrendingDown,
  irregular: Activity,
  lowCardio: Gauge,
};

const EVENT_TYPES = [
  'HighHeartRateEvent',
  'LowHeartRateEvent',
  'IrregularHeartRhythmEvent',
  'LowCardioFitnessEvent',
].map((s) => `HKCategoryTypeIdentifier${s}`);

const EVENT_ORDER: HeartEventType[] = ['high', 'low', 'irregular', 'lowCardio'];
const EVENT_ROWS = 12;

function HeartEvents({ fromDay, toDay }: { fromDay?: string; toDay?: string }) {
  const t = useT();
  const fmt = useFormat();
  const m = useMetricFormat();
  const q = useApi<HeartEvent[]>(
    ['health', 'heart', 'events'],
    '/health/heart/events',
    { fromDay, toDay },
    { enabled: !!toDay },
  );
  const events = q.data ?? [];
  const counts = useMemo(() => {
    const c: Record<HeartEventType, number> = { high: 0, low: 0, irregular: 0, lowCardio: 0 };
    for (const e of events) c[e.type]++;
    return c;
  }, [events]);
  const shown = EVENT_ORDER.filter((k) => counts[k] > 0);

  return (
    <Card>
      <CardHeader
        title={t('health.heart.events.title')}
        subtitle={t('health.heart.events.subtitle')}
        icon={HeartPulse}
      />
      {q.error ? (
        <ErrorState error={q.error} />
      ) : events.length === 0 ? (
        <div className="flex items-start gap-3 rounded-control bg-surface-2 px-4 py-3">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-good-fg" aria-hidden />
          <div>
            <div className="text-sm font-medium text-fg">{t('health.heart.events.none')}</div>
            <div className="text-xs text-fg-3">{t('health.heart.events.noneHint')}</div>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            {shown.map((k) => (
              <Stat key={k} label={t(`health.heart.events.${k}`)} value={fmt.int(counts[k])} />
            ))}
          </div>
          <Table className="max-h-80">
            <thead>
              <tr>
                <TH>{t('health.heart.events.when')}</TH>
                <TH>{t('health.heart.events.type')}</TH>
                <TH numeric>{t('health.heart.events.thresholdLabel')}</TH>
              </tr>
            </thead>
            <tbody>
              {events.slice(0, EVENT_ROWS).map((e) => {
                const Icon = EVENT_ICON[e.type];
                return (
                  <tr key={`${e.type}-${e.ts}`}>
                    <TD>{fmt.date(e.ts, e.tzMin, 'dateTime')}</TD>
                    <TD>
                      <Badge tone={e.type === 'lowCardio' ? 'neutral' : 'warning'} icon={Icon}>
                        {t(`health.heart.events.${e.type}`)}
                      </Badge>
                    </TD>
                    <TD numeric>
                      {e.threshold !== null ? m.value(HK.heartRate, e.threshold) : '–'}
                    </TD>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {events.length > EVENT_ROWS && (
            <p className="mt-2 text-xs text-fg-3">
              {t('health.heart.events.moreShown', { count: EVENT_ROWS, total: events.length })}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

export default function HeartPage() {
  const t = useT();
  const fmt = useFormat();
  const m = useMetricFormat();
  const theme = useChartTheme();
  const { range, setRange, fromDay, toDay, meta } = useRange('heart', '1y');
  const ready = !!meta.data?.asOf;
  // charts of metrics this athlete never recorded (walking HR without an Apple Watch …) are left out
  const has = useHasMetric();
  // Apple's or COROS' keys (Settings → My watch), as the server reads them
  const metrics = useHeartMetrics();
  const RHR = metrics.restingHr;
  const HRV = metrics.hrv;
  const VO2 = metrics.vo2max;
  const HR = metrics.heartRate;
  // a week before the range warms up the 7-day averages at the left edge
  const warmFrom = fromDay ? shiftDay(fromDay, -7) : undefined;
  const daily = useDaily([RHR, HRV, WHR, HR, VO2, REC], warmFrom, toDay, ready);
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const day = pickedDay ?? meta.data?.asOf ?? null;
  const dayRhr = useDaily([RHR], day ?? undefined, day ?? undefined, !!day);
  const rhrOfDay = dayRhr.data?.[RHR]?.[0]?.value;

  const d = daily.data;
  // stable point arrays: picking another day in the intraday card must not rebuild the trend charts
  const pts = useMemo(
    () => ({
      rhr: toPoints(d?.[RHR]),
      hrv: toPoints(d?.[HRV]),
      hr: toPoints(d?.[HR]),
      whr: toPoints(d?.[WHR]),
      vo2: toPoints(d?.[VO2]),
      rec: toPoints(d?.[REC]),
    }),
    [d, RHR, HRV, HR, VO2],
  );
  const loading = daily.isLoading;
  const noRange = t('health.common.noDataRange');

  return (
    <Page>
      <PageHeader title={t('health.titles.HeartPage')} subtitle={t('health.heart.subtitle')} icon={Heart}>
        <FilterBar>
          <RangeSelect value={range} onChange={setRange} />
        </FilterBar>
      </PageHeader>

      {(meta.error || daily.error) && <ErrorState error={meta.error ?? daily.error} className="mb-4" />}

      {meta.data && !ready && (
        <Card>
          <EmptyState
            icon={Heart}
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
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-2">
            {has(RHR) && (
              <TrendChart
                title={t('health.heart.restingHr.title')}
                subtitle={t('health.heart.restingHr.subtitle')}
                icon={HeartPulse}
                metric={RHR}
                unit="count/min"
                points={pts.rhr}
                fromDay={fromDay}
                color={measureColor(theme, 'restingHr')}
                rolling={7}
                good="down"
                loading={loading}
                emptyText={noRange}
              />
            )}
            {has(HRV) && (
              <TrendChart
                title={t('health.heart.hrv.title')}
                subtitle={t('health.heart.hrv.subtitle')}
                icon={Activity}
                metric={HRV}
                unit="ms"
                points={pts.hrv}
                fromDay={fromDay}
                color={measureColor(theme, 'hrv')}
                rolling={7}
                good="up"
                loading={loading}
                emptyText={noRange}
              />
            )}
            {has(HR) && (
              <div className="xl:col-span-2">
                <TrendChart
                  title={t('health.heart.range.title')}
                  subtitle={t('health.heart.range.subtitle')}
                  icon={Heart}
                  metric={HR}
                  unit="count/min"
                  points={pts.hr}
                  fromDay={fromDay}
                  color={measureColor(theme, 'heartRate')}
                  band
                  height={280}
                  loading={loading}
                  emptyText={noRange}
                />
              </div>
            )}
            {has(WHR) && (
              <TrendChart
                title={t('health.heart.walking.title')}
                subtitle={t('health.heart.walking.subtitle')}
                icon={Heart}
                metric={WHR}
                unit="count/min"
                points={pts.whr}
                fromDay={fromDay}
                color={measureColor(theme, 'walkingHr')}
                rolling={7}
                good="down"
                loading={loading}
                emptyText={noRange}
              />
            )}
            {has(VO2) && (
              <TrendChart
                title={t('health.heart.vo2.title')}
                subtitle={t('health.heart.vo2.subtitle')}
                icon={Gauge}
                metric={VO2}
                unit="mL/min·kg"
                points={pts.vo2}
                fromDay={fromDay}
                color={measureColor(theme, 'vo2max')}
                good="up"
                loading={loading}
                emptyText={noRange}
              />
            )}
            {has(REC) && (
              <TrendChart
                title={t('health.heart.recovery.title')}
                subtitle={t('health.heart.recovery.subtitle')}
                icon={TrendingDown}
                metric={REC}
                unit="count/min"
                points={pts.rec}
                fromDay={fromDay}
                color={measureColor(theme, 'recovery')}
                good="up"
                loading={loading}
                height={200}
                emptyText={t('health.heart.recovery.empty')}
              />
            )}
          </div>

          {EVENT_TYPES.some(has) && <HeartEvents fromDay={fromDay} toDay={toDay} />}

          {/* the day's samples: Apple Watch heart rate (COROS only reports daily values) */}
          {day && meta.data && HR.startsWith('HK') && has(HR) && (
            <IntradayChart
              type={HR}
              unit="count/min"
              day={day}
              title={t('health.heart.intraday.title')}
              subtitle={`${fmt.day(day, 'weekday')} · ${t('health.heart.intraday.subtitle')}`}
              icon={HeartPulse}
              color={measureColor(theme, 'heartRate')}
              reference={
                rhrOfDay !== undefined
                  ? {
                      value: rhrOfDay,
                      label: t('health.heart.intraday.resting', { value: m.value(RHR, rhrOfDay) }),
                    }
                  : null
              }
              workouts
              height={280}
              actions={
                <DayNav
                  day={day}
                  onChange={setPickedDay}
                  min={meta.data.firstDay ?? undefined}
                  max={meta.data.asOf ?? undefined}
                  prevLabel={t('health.heart.intraday.prev')}
                  nextLabel={t('health.heart.intraday.next')}
                  pickLabel={t('health.heart.intraday.pick')}
                />
              }
            />
          )}
        </div>
      )}
    </Page>
  );
}
