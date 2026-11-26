import { useMemo } from 'react';
import { Dumbbell, Percent, Ruler, Scale } from 'lucide-react';
import { Link } from 'react-router';
import { bmiSeries, leanMassSeries, trailingChange, type BloodPressureReading } from '@cadence/shared';
import { useChartTheme } from '@/components/charts/theme';
import { Button, Card, EmptyState, ErrorState, FilterBar, Page, PageHeader, Skeleton, Stat, StatRow } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { useHasMetric } from '@/lib/sources';
import { BloodPressureCard } from '../components/body/BloodPressureCard';
import { MonthlyChangeChart } from '../components/body/MonthlyChangeChart';
import { RangeSelect } from '../components/RangeSelect';
import { TrendChart, type TrendPoint } from '../components/TrendChart';
import { TrendDelta } from '../components/TrendDelta';
import { measureColor } from '../lib/colors';
import { useDaily, useRange } from '../lib/hooks';
import { useMetricFormat } from '../lib/metrics';
import { toPoints } from '../lib/series';

const MASS = 'HKQuantityTypeIdentifierBodyMass';
const BMI = 'HKQuantityTypeIdentifierBodyMassIndex';
const FAT = 'HKQuantityTypeIdentifierBodyFatPercentage';
const LEAN = 'HKQuantityTypeIdentifierLeanBodyMass';
const HEIGHT = 'HKQuantityTypeIdentifierHeight';
const SYS = 'HKQuantityTypeIdentifierBloodPressureSystolic';
/** Highest limit the endpoint accepts. */
const BP_LIMIT = 5000;

interface Tile {
  key: string;
  label: string;
  metric: string;
  unit: string;
  points: TrendPoint[];
}

export default function BodyPage() {
  const t = useT();
  const m = useMetricFormat();
  const theme = useChartTheme();
  const { range, setRange, fromDay, toDay, meta } = useRange('body', '1y');
  const ready = !!meta.data?.asOf;
  // everything since the first measurement: rolling means and monthly changes need the days before the range
  const daily = useDaily([MASS, BMI, FAT, LEAN, HEIGHT], undefined, toDay, ready);
  // per range: the server returns at most `limit` readings, the oldest first
  const bpQ = useApi<BloodPressureReading[]>(
    ['health', 'body', 'bp'],
    '/health/body/blood-pressure',
    { fromDay, toDay, limit: BP_LIMIT },
    { enabled: ready },
  );
  const has = useHasMetric();

  const data = useMemo(() => {
    const d = daily.data;
    if (!d) return null;
    const weight = toPoints(d[MASS]);
    const heightRows = d[HEIGHT] ?? [];
    const heightM = heightRows.length ? heightRows[heightRows.length - 1]!.value : null;
    const bmiRecorded = toPoints(d[BMI]);
    const fat = toPoints(d[FAT]);
    const leanRecorded = toPoints(d[LEAN]);
    return {
      weight,
      heightM,
      bmi: { points: bmiRecorded.length ? bmiRecorded : bmiSeries(weight, heightM), computed: !bmiRecorded.length },
      fat,
      lean: { points: leanRecorded.length ? leanRecorded : leanMassSeries(weight, fat), computed: !leanRecorded.length },
    };
  }, [daily.data]);

  const bpAll = bpQ.data ?? [];
  // the previous range stays visible while the next one loads
  const bpRange = useMemo(() => bpAll.filter((r) => (!fromDay || r.day >= fromDay) && (!toDay || r.day <= toDay)), [bpAll, fromDay, toDay]);
  // readings outside the selected range still count: the card then says the range has none
  const hasBp = bpAll.length > 0 || has(SYS);
  const hasAny =
    !!data && (data.weight.length > 0 || data.bmi.points.length > 0 || data.fat.length > 0 || data.lean.points.length > 0 || data.heightM !== null || hasBp);
  const noRange = t('health.common.noDataRange');

  const tiles: Tile[] = data
    ? [
        { key: 'weight', label: m.name(MASS), metric: MASS, unit: 'kg', points: data.weight },
        { key: 'bmi', label: m.name(BMI), metric: BMI, unit: 'count', points: data.bmi.points },
        { key: 'fat', label: m.name(FAT), metric: FAT, unit: '%', points: data.fat },
        { key: 'lean', label: m.name(LEAN), metric: LEAN, unit: 'kg', points: data.lean.points },
      ].filter((x) => x.points.length > 0)
    : [];

  return (
    <Page>
      <PageHeader title={t('health.titles.BodyPage')} subtitle={t('health.body.subtitle')} icon={Scale}>
        <FilterBar>
          <RangeSelect value={range} onChange={setRange} />
        </FilterBar>
      </PageHeader>

      {(meta.error || daily.error || bpQ.error) && <ErrorState error={meta.error ?? daily.error ?? bpQ.error} className="mb-4" />}

      {((meta.data && !ready) || (data && !hasAny && bpQ.data)) && (
        <Card>
          <EmptyState
            icon={Scale}
            title={t('health.body.empty.title')}
            description={t('health.body.empty.description')}
            action={
              <Link to="/health/explorer">
                <Button>{t('health.nav.explorer')}</Button>
              </Link>
            }
          />
        </Card>
      )}

      {ready && !data && (
        <div className="space-y-4">
          <Skeleton className="h-[96px] w-full" />
          <Skeleton className="h-[320px] w-full" />
        </div>
      )}

      {ready && data && hasAny && (
        <div className="space-y-4">
          <Card>
            <StatRow>
              {tiles.map((x) => {
                const last = x.points[x.points.length - 1]!;
                const change = trailingChange(x.points, 30, 14);
                const delta = change ? m.delta(x.metric, change.diff, x.unit) : null;
                const p = m.parts(x.metric, last.value, x.unit);
                return (
                  <Stat
                    key={x.key}
                    label={x.label}
                    value={p.value}
                    unit={p.unit}
                    delta={delta && <TrendDelta value={delta.value} text={delta.text} good={m.good(x.metric)} />}
                    hint={delta ? t('health.body.tiles.change30') : undefined}
                  />
                );
              })}
              {data.heightM !== null && (
                <Stat
                  label={m.name(HEIGHT)}
                  value={m.parts(HEIGHT, data.heightM, 'm').value}
                  unit={m.parts(HEIGHT, data.heightM, 'm').unit}
                />
              )}
            </StatRow>
          </Card>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-2">
            {data.weight.length > 0 && (
              <>
                <TrendChart
                  title={t('health.body.weight.title')}
                  subtitle={t('health.body.weight.subtitle')}
                  icon={Scale}
                  metric={MASS}
                  unit="kg"
                  points={data.weight}
                  fromDay={fromDay}
                  color={measureColor(theme, 'weight')}
                  rolling={7}
                  good={null}
                  emptyText={noRange}
                />
                <MonthlyChangeChart
                  points={data.weight}
                  fromDay={fromDay}
                  metric={MASS}
                  unit="kg"
                  color={measureColor(theme, 'weight')}
                  title={t('health.body.monthly.title')}
                  subtitle={t('health.body.monthly.subtitle')}
                />
              </>
            )}
            {data.bmi.points.length > 0 && (
              <TrendChart
                title={t('health.body.bmi.title')}
                subtitle={t('health.body.bmi.subtitle')}
                icon={Ruler}
                metric={BMI}
                unit="count"
                points={data.bmi.points}
                fromDay={fromDay}
                color={measureColor(theme, 'bmi')}
                rolling={7}
                good={null}
                emptyText={noRange}
                footerExtra={data.bmi.computed ? <span className="text-fg-3">{t('health.body.bmi.computed')}</span> : undefined}
              />
            )}
            {data.fat.length > 0 && (
              <TrendChart
                title={t('health.body.fat.title')}
                subtitle={t('health.body.fat.subtitle')}
                icon={Percent}
                metric={FAT}
                unit="%"
                points={data.fat}
                fromDay={fromDay}
                color={measureColor(theme, 'bodyFat')}
                rolling={7}
                good="down"
                emptyText={noRange}
              />
            )}
            {data.lean.points.length > 0 && (
              <TrendChart
                title={t('health.body.lean.title')}
                subtitle={t('health.body.lean.subtitle')}
                icon={Dumbbell}
                metric={LEAN}
                unit="kg"
                points={data.lean.points}
                fromDay={fromDay}
                color={measureColor(theme, 'lean')}
                rolling={7}
                good="up"
                emptyText={noRange}
                footerExtra={data.lean.computed ? <span className="text-fg-3">{t('health.body.lean.computed')}</span> : undefined}
              />
            )}
            {hasBp && (
              <div className="xl:col-span-2">
                <BloodPressureCard readings={bpRange} loading={bpQ.isLoading} />
              </div>
            )}
          </div>
        </div>
      )}
    </Page>
  );
}
