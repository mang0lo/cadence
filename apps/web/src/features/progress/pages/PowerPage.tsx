import { Zap } from 'lucide-react';
import {
  PROGRESS_POWER_COMPARES,
  PROGRESS_POWER_PERIODS,
  type ProgressPowerCompare,
  type ProgressPowerPeriod,
} from '@cadence/shared';
import {
  ErrorState,
  FilterBar,
  Input,
  Page,
  PageHeader,
  SegmentedControl,
  Select,
  cn,
} from '@/components/ui';
import { useT } from '@/lib/i18n';
import { addDays, todayKey } from '@/lib/time';
import { useUrlParams } from '@/lib/urlParams';
import { useFtpEstimate, usePowerCurve } from '../api';
import { CardSkeleton, SportSelect } from '../components/common';
import { FtpCard, FtpHistoryCard, NoPowerCard, PowerBestsCard, PowerCurveCard } from '../components/power';
import { isPowerCompare, isPowerPeriod, type PowerUnit } from '../power';
import { urlSport } from '../useFilters';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Power curve ("Leistungskurve"): best average power per duration for a sport and period, compared with the
 * all-time bests or the period before, plus the FTP estimate and its history. Filters live in the URL.
 */
export default function PowerPage() {
  const t = useT();
  const [params, set] = useUrlParams();
  const today = todayKey();
  const rawPeriod = params.get('period');
  const period: ProgressPowerPeriod = isPowerPeriod(rawPeriod) ? rawPeriod : '90d';
  const rawCompare = params.get('compare');
  const compare: ProgressPowerCompare = isPowerCompare(rawCompare) ? rawCompare : 'allTime';
  const year = Number(params.get('year')) || Number(today.slice(0, 4));
  let from = params.get('from') ?? '';
  let to = params.get('to') ?? '';
  if (!DAY_RE.test(from)) from = addDays(today, -89);
  if (!DAY_RE.test(to)) to = today;
  if (from > to) [from, to] = [to, from];
  // an unknown ?sport= (old link) is dropped: the server's default sport applies and the picker stays usable
  const asked = urlSport(params.get('sport'));

  const curve = usePowerCurve({ sport: asked, period, year, fromDay: from, toDay: to, compare });
  const ftp = useFtpEstimate(asked);
  const data = curve.data;
  const sport = data?.sport ?? asked ?? '';
  const unit: PowerUnit = params.get('unit') === 'wkg' && data?.current.bodyMass ? 'wkg' : 'w';
  // without any power data there is nothing to filter (the empty state explains what is needed)
  const noPower = !!data && !data.sports.length;
  const sports =
    data && sport && !noPower && !data.sports.some((s) => s.sport === sport)
      ? [...data.sports, { sport, workouts: 0 }]
      : (data?.sports ?? []);
  const years = [...new Set([...(data?.years ?? []), year])].sort((a, b) => b - a);

  const setPeriod = (p: ProgressPowerPeriod) => {
    if (p === 'year') set({ period: p, year: params.get('year') ?? String(data?.years[0] ?? year) });
    else if (p === 'custom')
      set({ period: p, from: data?.current.fromDay ?? from, to: data?.current.toDay ?? to });
    else set({ period: p });
  };

  return (
    <Page>
      <PageHeader title={t('progress.titles.PowerPage')} subtitle={t('progress.power.subtitle')} icon={Zap}>
        {!noPower && (
          <FilterBar>
            {sports.length > 0 && (
              <SportSelect
                value={sport}
                allowAll={false}
                onChange={(s) => set({ sport: s })}
                sports={sports}
              />
            )}
            <SegmentedControl
              value={period}
              onChange={setPeriod}
              label={t('progress.filters.period')}
              items={PROGRESS_POWER_PERIODS.map((p) => ({
                value: p,
                label: t(`progress.power.periods.${p}`),
              }))}
            />
            {period === 'year' && (
              <div className="w-28">
                <Select
                  value={String(year)}
                  onChange={(y) => set({ year: y })}
                  options={years.map((y) => ({ value: String(y), label: String(y) }))}
                  aria-label={t('progress.power.filters.year')}
                />
              </div>
            )}
            {period === 'custom' && (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="date"
                  aria-label={t('progress.power.filters.from')}
                  value={from}
                  max={to}
                  onChange={(e) => e.target.value && set({ from: e.target.value })}
                  className="w-auto"
                />
                <span className="text-xs text-fg-3">–</span>
                <Input
                  type="date"
                  aria-label={t('progress.power.filters.to')}
                  value={to}
                  min={from}
                  max={today}
                  onChange={(e) => e.target.value && set({ to: e.target.value })}
                  className="w-auto"
                />
              </div>
            )}
            {period !== 'all' && (
              <SegmentedControl
                value={compare}
                onChange={(c) => set({ compare: c })}
                label={t('progress.power.filters.compare')}
                items={PROGRESS_POWER_COMPARES.map((c) => ({
                  value: c,
                  label: t(`progress.power.compares.${c}`),
                }))}
              />
            )}
            {data?.current.bodyMass && (
              <SegmentedControl
                value={unit}
                onChange={(u) => set({ unit: u === 'wkg' ? 'wkg' : null })}
                label={t('progress.power.filters.unit')}
                items={[
                  { value: 'w', label: 'W' },
                  { value: 'wkg', label: 'W/kg' },
                ]}
              />
            )}
          </FilterBar>
        )}
      </PageHeader>
      {curve.error ? (
        <ErrorState error={curve.error} />
      ) : !data ? (
        <div className="grid gap-4">
          <CardSkeleton title={t('progress.power.bests.title')} height={88} />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <CardSkeleton title={t('progress.power.curve.title')} height={320} />
            <CardSkeleton title={t('progress.power.ftp.title')} height={320} />
          </div>
        </div>
      ) : noPower ? (
        <NoPowerCard />
      ) : (
        <div className="grid gap-4">
          <PowerBestsCard data={data} unit={unit} />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <PowerCurveCard data={data} unit={unit} loading={curve.isFetching} />
            <div className={cn('grid min-w-0 transition-opacity', ftp.isFetching && 'opacity-60')}>
              <FtpCard data={ftp.data} error={ftp.error} />
            </div>
          </div>
          <FtpHistoryCard data={ftp.data} loading={ftp.isFetching} error={ftp.error} />
        </div>
      )}
    </Page>
  );
}
