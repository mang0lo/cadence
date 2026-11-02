import { useMemo } from 'react';
import { Check, Clock, Gauge, LineChart } from 'lucide-react';
import type { ConsistencyPrefs, ConsistencyScore } from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { axisTooltip, grid, lineSeries, timeAxis, tooltipHtml, valueAxis } from '@/components/charts/options';
import { useChartTheme } from '@/components/charts/theme';
import { Card, CardHeader, EmptyState, Field, Hint, SegmentedControl, Select, cn } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { dayToDate } from '@/lib/time';
import { useConsistencyMutations } from '../api';
import { FieldGroup } from './FieldGroup';

function level(score: number): 'excellent' | 'good' | 'fair' | 'low' {
  if (score >= 0.85) return 'excellent';
  if (score >= 0.65) return 'good';
  if (score >= 0.4) return 'fair';
  return 'low';
}

/** Score (share of the last 12 complete weeks that count), the 12-week strip and its explanation. */
export function ScoreCard({ score, prefs }: { score: ConsistencyScore; prefs: ConsistencyPrefs }) {
  const t = useT();
  const fmt = useFormat();
  const { setPrefs } = useConsistencyMutations();
  const current = score.weeks[score.weeks.length - 1];
  const explain =
    score.basis === 'goals'
      ? t('consistency.score.explainGoals', { total: score.total, count: score.weeklyGoals })
      : t('consistency.score.explainDays', { total: score.total, count: score.minActiveDays });

  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader title={t('consistency.score.title')} subtitle={t('consistency.score.subtitle')} icon={Gauge} />
      {score.score === null ? (
        <EmptyState className="py-6" title={t('consistency.score.noScore')} />
      ) : (
        <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
          <span className="text-5xl font-semibold tracking-tight text-fg">{fmt.pct(score.score)}</span>
          <div className="pb-1.5">
            <div className="text-sm font-semibold text-fg">{t(`consistency.score.levels.${level(score.score)}`)}</div>
            <div className="text-xs text-fg-3">{t('consistency.score.weeksMet', { met: score.met, total: score.total })}</div>
          </div>
        </div>
      )}

      <div className="mt-4 grid grid-cols-[repeat(13,minmax(0,1.75rem))] gap-1" role="list" aria-label={t('consistency.score.strip')}>
        {score.weeks.map((w) => {
          const label = `${t('consistency.score.weekOf', { date: fmt.day(w.weekStart, 'day') })}: ${t('common.days', { count: w.activeDays })} · ${t('common.activities', { count: w.activities })} · ${fmt.durationShort(w.durationS)}`;
          const status = w.inProgress ? t('consistency.score.inProgress') : w.met ? t('consistency.score.met') : t('consistency.score.missed');
          return (
            <Hint key={w.weekStart} content={`${label} — ${status}`}>
              <span
                role="listitem"
                tabIndex={0}
                aria-label={`${label} — ${status}`}
                className={cn(
                  'grid aspect-square w-full place-items-center rounded-md text-on-accent',
                  w.inProgress ? 'border border-dashed border-border-strong text-fg-3' : w.met ? 'bg-accent' : 'bg-surface-3',
                )}
              >
                {w.inProgress ? <Clock size={13} aria-hidden /> : w.met ? <Check size={14} strokeWidth={3} aria-hidden /> : null}
              </span>
            </Hint>
          );
        })}
      </div>
      {current && (
        <p className="mt-2 text-xs text-fg-3">
          {t('consistency.score.thisWeek', { count: current.activeDays })}
        </p>
      )}

      <p className="mt-3 text-sm text-fg-2">{explain}</p>
      {prefs.scoreBasis === 'goals' && score.basis === 'days' && (
        <p className="mt-1 text-xs text-fg-3">{t('consistency.score.fallback')}</p>
      )}

      <div className="mt-auto flex flex-wrap items-end gap-3 pt-4">
        <FieldGroup label={t('consistency.score.basis')}>
          <SegmentedControl
            size="sm"
            value={prefs.scoreBasis}
            onChange={(v) => void setPrefs({ scoreBasis: v }).catch(() => undefined)}
            items={[
              { value: 'days', label: t('consistency.score.basisDays') },
              { value: 'goals', label: t('consistency.score.basisGoals') },
            ]}
          />
        </FieldGroup>
        {prefs.scoreBasis === 'days' && (
          <Field label={t('consistency.score.minDays')}>
            <Select
              value={String(prefs.minActiveDays)}
              onChange={(v) => void setPrefs({ minActiveDays: Number(v) }).catch(() => undefined)}
              className="h-8 text-xs"
              options={[1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: String(n), label: t('consistency.score.perWeek', { count: n }) }))}
            />
          </Field>
        )}
      </div>
    </Card>
  );
}

/** Rolling 12-week score over the last year. */
export function ScoreTrendCard({ score }: { score: ConsistencyScore }) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const points = score.trend.filter((p) => p.score !== null);
  const option = useMemo(
    () => ({
      grid: grid({ top: 12 }),
      tooltip: axisTooltip(theme, (params: unknown) => {
        const p = (params as { value: [number, number]; color: string }[])[0];
        if (!p) return '';
        const day = new Date(p.value[0]).toISOString().slice(0, 10);
        return tooltipHtml(
          t('consistency.score.weekOf', { date: fmt.day(day, 'day') }),
          [{ color: theme.series[0]!, label: t('consistency.score.title'), value: fmt.pct(p.value[1]) }],
          theme,
        );
      }),
      xAxis: timeAxis(theme),
      yAxis: valueAxis(theme, { min: 0, max: 1, interval: 0.25, axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => fmt.pct(v) } }),
      series: [
        lineSeries(
          theme,
          t('consistency.score.title'),
          points.map((p) => [dayToDate(p.weekStart).getTime(), p.score]),
          theme.series[0]!,
          { step: 'end', areaStyle: { color: theme.series[0], opacity: 0.1 } },
        ),
      ],
    }),
    [points, theme, fmt, t],
  );
  return (
    <ChartCard
      title={t('consistency.score.trend')}
      subtitle={t('consistency.score.trendSubtitle')}
      icon={LineChart}
      table={{
        columns: [
          { key: 'week', label: t('common.week') },
          { key: 'score', label: t('consistency.score.title'), numeric: true },
        ],
        rows: [...points].reverse().map((p) => ({
          week: fmt.day(p.weekStart, 'day'),
          score: fmt.pct(p.score!),
        })),
      }}
    >
      {points.length < 2 ? (
        <EmptyState className="py-10" title={t('consistency.score.noScore')} />
      ) : (
        <EChart option={option} height={240} ariaLabel={t('consistency.score.trend')} />
      )}
    </ChartCard>
  );
}
