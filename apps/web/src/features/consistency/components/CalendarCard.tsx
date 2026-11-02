import { useMemo } from 'react';
import { CalendarRange } from 'lucide-react';
import type { CalendarResponse } from '@cadence/shared';
import { CalendarHeatmap } from '@/components/charts/CalendarHeatmap';
import { ChartCard, type TableView } from '@/components/charts/ChartCard';
import { SegmentedControl, Skeleton, cn } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { sportLabel, sortSports } from '@/lib/sports';
import { useStoredState } from '@/lib/storage';
import { CALENDAR_METRICS, calendarValue, formatCalendarValue, type CalendarMetric } from '../lib';

/** Move-ring % steps: ≤ 50 %, ≤ 75 %, < 100 %, closed (100–150 %), > 150 %. */
const MOVE_THRESHOLDS = [0.5, 0.75, 0.999, 1.5];

/** Big per-year calendar heatmap with a metric switch; clicking a day selects it. */
export function CalendarCard({
  year,
  asOf,
  weekStart,
  data,
  loading,
  selectedDay,
  onSelectDay,
}: {
  year: number;
  asOf: string;
  weekStart: 0 | 1;
  data: CalendarResponse | undefined;
  loading: boolean;
  selectedDay: string | null;
  onSelectDay: (day: string) => void;
}) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const [metric, setMetric] = useStoredState<CalendarMetric>('consistency.calendarMetric', 'minutes');
  const m: CalendarMetric = CALENDAR_METRICS.includes(metric) ? metric : 'minutes';
  const from = `${year}-01-01`;
  // the running year ends at asOf (no fake "inactive" future days)
  const to = asOf >= from && asOf < `${year}-12-31` ? asOf : `${year}-12-31`;
  const days = useMemo(() => (data ? data.days.filter((d) => d.day >= from && d.day <= to) : []), [data, from, to]);
  const byDay = useMemo(() => new Map(days.map((d) => [d.day, d])), [days]);
  const values = useMemo(() => {
    const out: Record<string, number> = {};
    for (const d of days) {
      const v = calendarValue(d, m);
      if (v > 0) out[d.day] = v;
    }
    return out;
  }, [days, m]);

  const active = days.filter((d) => d.count > 0);
  const totalS = active.reduce((s, d) => s + d.durationS, 0);
  const hasRings = days.some((d) => d.move !== null);

  const table: TableView = {
    columns: [
      { key: 'day', label: t('consistency.calendar.table.day') },
      { key: 'activities', label: t('consistency.calendar.metrics.activities'), numeric: true },
      { key: 'minutes', label: t('consistency.calendar.metrics.minutes'), numeric: true },
      { key: 'distance', label: t('consistency.calendar.metrics.distance'), numeric: true },
      { key: 'effort', label: t('consistency.calendar.metrics.effort'), numeric: true },
      ...(hasRings ? [{ key: 'move', label: t('consistency.calendar.metrics.move'), numeric: true }] : []),
    ],
    rows: days
      .filter((d) => d.count > 0 || (m === 'move' && d.move !== null))
      .map((d) => ({
        day: fmt.day(d.day, 'weekdayShort'),
        activities: fmt.int(d.count),
        minutes: d.count ? fmt.durationShort(d.durationS) : '–',
        distance: d.distanceM > 0 ? fmt.distance(d.distanceM) : '–',
        effort: d.count ? fmt.int(d.effort) : '–',
        move: d.move !== null ? fmt.pct(d.move) : '–',
      })),
  };

  const items = CALENDAR_METRICS.filter((x) => x !== 'move' || hasRings).map((x) => ({
    value: x,
    label: t(`consistency.calendar.metrics.${x}`),
  }));

  return (
    <ChartCard
      title={t('consistency.calendar.title', { year })}
      subtitle={
        data
          ? t('consistency.calendar.summary', {
              days: t('common.days', { count: active.length }),
              time: fmt.durationShort(totalS),
            })
          : undefined
      }
      icon={CalendarRange}
      actions={
        <SegmentedControl
          size="sm"
          value={m}
          onChange={setMetric}
          items={items}
          label={t('consistency.calendar.metric')}
        />
      }
      table={table}
      footer={t('consistency.calendar.clickHint')}
    >
      {!data ? (
        <Skeleton className="aspect-[7/1] w-full" />
      ) : (
        <div className={cn('transition-opacity', loading && 'opacity-50')}>
          <CalendarHeatmap
            values={values}
            from={from}
            to={to}
            weekStart={weekStart}
            ramp={m === 'move' ? 'blue' : 'orange'}
            thresholds={m === 'move' ? MOVE_THRESHOLDS : undefined}
            cell={15}
            gap={3}
            selectedDay={selectedDay}
            onSelectDay={onSelectDay}
            tooltip={(day) => {
              const d = byDay.get(day);
              const v = d ? calendarValue(d, m) : 0;
              return (
                <>
                  <div className="font-semibold">
                    {v > 0 ? formatCalendarValue(fmt, t, m, v) : t('consistency.calendar.noActivity')}
                  </div>
                  <div className="text-fg-3">{fmt.day(day, 'weekdayShort')}</div>
                  {d && d.sports.length > 0 && (
                    <div className="text-fg-2">{sortSports(d.sports).map((s) => sportLabel(s, lang)).join(', ')}</div>
                  )}
                </>
              );
            }}
          />
        </div>
      )}
    </ChartCard>
  );
}
