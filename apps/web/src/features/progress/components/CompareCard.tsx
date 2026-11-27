import { useState, type ReactNode } from 'react';
import { ArrowLeftRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { sportInfo, type ProgressCompareTotals } from '@cadence/shared';
import { Card, CardHeader, ErrorState, IconButton, Input, SegmentedControl, Skeleton, Table, TD, TH } from '@/components/ui';
import { showsPace, speedFormat, useFormat, type Formatter } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { addDays, todayKey } from '@/lib/time';
import { useCompare } from '../api';
import { signedRounded } from '../format';
import { ChangeBadge } from './common';

type Mode = 'rolling' | 'week' | 'month' | 'year' | 'custom';
const MODES: Mode[] = ['rolling', 'week', 'month', 'year', 'custom'];

interface Row {
  key: string;
  label: string;
  current: number | null;
  previous: number | null;
  format: (v: number) => string;
  /** 'pct' = relative change, 'abs' = formatted difference. */
  change: 'pct' | 'abs';
  better: 'up' | 'down' | null;
  /** Formats the absolute difference (for 'abs'). */
  delta?: (a: number, b: number) => string;
  /** Signed difference that drives the arrow (default b − a; pace: change of the pace number). */
  deltaValue?: (a: number, b: number) => number;
}

function rowsFor(cur: ProgressCompareTotals, prev: ProgressCompareTotals, sport: string, fmt: Formatter, t: (k: string) => string): Row[] {
  const hasDistance = sport === 'all' || sportInfo(sport).distance;
  const rows: Row[] = [
    { key: 'count', label: t('progress.compare.metrics.count'), current: cur.count, previous: prev.count, format: fmt.int, change: 'pct', better: 'up' },
    { key: 'activeDays', label: t('progress.compare.metrics.activeDays'), current: cur.activeDays, previous: prev.activeDays, format: fmt.int, change: 'pct', better: 'up' },
  ];
  if (hasDistance)
    rows.push({ key: 'distance', label: t('progress.compare.metrics.distance'), current: cur.distanceM, previous: prev.distanceM, format: (v) => fmt.distance(v), change: 'pct', better: 'up' });
  rows.push({ key: 'moving', label: t('progress.compare.metrics.moving'), current: cur.movingS, previous: prev.movingS, format: (v) => fmt.durationShort(v), change: 'pct', better: 'up' });
  if (hasDistance)
    rows.push({ key: 'elevation', label: t('progress.compare.metrics.elevation'), current: cur.elevationM, previous: prev.elevationM, format: (v) => fmt.elevation(v), change: 'pct', better: 'up' });
  rows.push(
    { key: 'effort', label: t('progress.compare.metrics.effort'), current: cur.effort, previous: prev.effort, format: fmt.int, change: 'pct', better: 'up' },
    { key: 'energy', label: t('progress.compare.metrics.energy'), current: cur.energyKcal, previous: prev.energyKcal, format: (v) => fmt.energy(v), change: 'pct', better: 'up' },
  );
  if (sport !== 'all' && sportInfo(sport).distance && (cur.avgSpeed || prev.avgSpeed)) {
    const sf = speedFormat(fmt, sport);
    const pace = showsPace(sport);
    rows.push({
      key: 'speed',
      label: t(pace ? 'progress.compare.metrics.avgPace' : 'progress.compare.metrics.avgSpeed'),
      current: cur.avgSpeed,
      previous: prev.avgSpeed,
      format: sf.format,
      change: 'abs',
      // pace: a smaller number is faster; speed: a bigger one
      better: pace ? 'down' : 'up',
      delta: sf.delta,
      deltaValue: (a, b) => sf.toChart(b) - sf.toChart(a),
    });
  }
  rows.push({
    key: 'avgHr',
    label: t('progress.compare.metrics.avgHr'),
    current: cur.avgHr,
    previous: prev.avgHr,
    format: fmt.hr,
    change: 'abs',
    better: null,
    delta: (a, b) => `${signedRounded(fmt, b - a)} bpm`,
  });
  if (hasDistance)
    rows.push({ key: 'longest', label: t('progress.compare.metrics.longest'), current: cur.longestM, previous: prev.longestM, format: (v) => fmt.distance(v), change: 'pct', better: 'up' });
  else
    rows.push({ key: 'longestTime', label: t('progress.compare.metrics.longestTime'), current: cur.longestS, previous: prev.longestS, format: (v) => fmt.durationShort(v), change: 'pct', better: 'up' });
  return rows;
}

function ChangeCell({ row, t, fmt }: { row: Row; t: (k: string) => string; fmt: Formatter }): ReactNode {
  const { current: c, previous: p } = row;
  if (c === null || p === null) return <span className="text-fg-3">–</span>;
  if (row.change === 'abs') {
    const text = row.delta!(p, c);
    // formatters print '±' when the rounded difference is zero
    if (Math.abs(c - p) < 1e-9 || text.startsWith('±')) return <ChangeBadge value={0} text={text} better={null} />;
    return <ChangeBadge value={row.deltaValue ? row.deltaValue(p, c) : c - p} text={text} better={row.better} />;
  }
  if (p === 0) return c > 0 ? <ChangeBadge value={1} text={t('progress.compare.new')} better={row.better} /> : <span className="text-fg-3">–</span>;
  const pct = (c - p) / p;
  const text = `${signedRounded(fmt, pct * 100)} %`;
  return <ChangeBadge value={text.startsWith('±') ? 0 : pct} text={text} better={text.startsWith('±') ? null : row.better} />;
}

export function CompareCard({ sport }: { sport: string }) {
  const t = useT();
  const fmt = useFormat();
  const [mode, setMode] = useState<Mode>('rolling');
  const [offset, setOffset] = useState(0);
  const today = todayKey();
  const [custom, setCustom] = useState({ fromDay: addDays(today, -27), toDay: today });
  const validCustom = custom.fromDay && custom.toDay && custom.fromDay <= custom.toDay;
  const period = mode === 'rolling' || mode === 'custom' ? 'custom' : mode;
  const rangeParams =
    mode === 'rolling' ? { fromDay: addDays(today, -27), toDay: today } : mode === 'custom' && validCustom ? custom : null;
  const q = useCompare(sport, period, offset, rangeParams);
  const data = q.data;
  const stepper = mode === 'week' || mode === 'month' || mode === 'year';

  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader
        title={t('progress.compare.title')}
        icon={ArrowLeftRight}
        subtitle={
          data ? `${fmt.dayRange(data.current.fromDay, data.current.toDay)} ${t('progress.compare.vs')} ${fmt.dayRange(data.previous.fromDay, data.previous.toDay)}` : undefined
        }
        actions={
          stepper ? (
            <>
              <IconButton icon={ChevronLeft} label={t('progress.compare.earlier')} onClick={() => setOffset(offset + 1)} />
              <IconButton
                icon={ChevronRight}
                label={t('progress.compare.later')}
                disabled={offset === 0}
                className="disabled:opacity-40"
                onClick={() => setOffset(Math.max(0, offset - 1))}
              />
            </>
          ) : undefined
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SegmentedControl
          size="sm"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setOffset(0);
          }}
          label={t('progress.compare.title')}
          items={MODES.map((m) => ({ value: m, label: t(`progress.compare.periods.${m}`) }))}
        />
        {mode === 'custom' && (
          <div className="flex flex-wrap items-center gap-2">
            {/* h-8! — Input sets h-9 itself and cn does not merge conflicting utilities (h-9 comes later in the CSS) */}
            <Input
              type="date"
              aria-label={t('progress.compare.from')}
              value={custom.fromDay}
              max={custom.toDay || today}
              onChange={(e) => setCustom({ ...custom, fromDay: e.target.value })}
              className="h-8! w-auto text-xs"
            />
            <span className="text-xs text-fg-3">–</span>
            <Input
              type="date"
              aria-label={t('progress.compare.to')}
              value={custom.toDay}
              min={custom.fromDay}
              max={today}
              onChange={(e) => setCustom({ ...custom, toDay: e.target.value })}
              className="h-8! w-auto text-xs"
            />
          </div>
        )}
      </div>
      {q.error ? (
        <ErrorState error={q.error} />
      ) : !data ? (
        <div className="grid gap-2">
          {Array.from({ length: 9 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : (
        <div className={q.isFetching ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          <Table>
            <thead>
              <tr>
                <TH>{t('progress.compare.metric')}</TH>
                <TH numeric>{fmt.dayRange(data.current.fromDay, data.current.toDay)}</TH>
                <TH numeric>{fmt.dayRange(data.previous.fromDay, data.previous.toDay)}</TH>
                <TH numeric>{t('progress.compare.change')}</TH>
              </tr>
            </thead>
            <tbody>
              {rowsFor(data.current.totals, data.previous.totals, sport, fmt, t).map((r) => (
                <tr key={r.key}>
                  <TD className="text-fg">{r.label}</TD>
                  <TD numeric className="font-medium text-fg">
                    {r.current === null ? '–' : r.format(r.current)}
                  </TD>
                  <TD numeric>{r.previous === null ? '–' : r.format(r.previous)}</TD>
                  <TD numeric>
                    <ChangeCell row={r} t={t} fmt={fmt} />
                  </TD>
                </tr>
              ))}
            </tbody>
          </Table>
          {data.toDate && <p className="mt-2 text-xs text-fg-3">{t('progress.compare.toDate')}</p>}
        </div>
      )}
    </Card>
  );
}
