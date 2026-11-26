import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { Flag, ListOrdered, Medal, Mountain, Ruler, Timer, Trophy, Zap, LineChart as LineChartIcon } from 'lucide-react';
import type { EChartsOption } from 'echarts';
import {
  BEST_EFFORTS,
  workoutTitle,
  type ProgressEffortHistory,
  type ProgressEffortRef,
  type ProgressEffortRow,
  type ProgressHighlight,
  type ProgressHighlightKey,
  type ProgressPredictions,
} from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { grid, itemTooltip, lineSeries, scatterSeries, timeAxis, tooltipHtml, valueAxis } from '@/components/charts/options';
import { sportColor, useChartTheme, type ChartTheme } from '@/components/charts/theme';
import { RouteThumbnail } from '@/components/map/RouteThumbnail';
import { Badge, Card, CardHeader, EmptyState, ErrorState, Skeleton, Table, TD, TH, cn } from '@/components/ui';
import { clock, useFormat, type Formatter } from '@/lib/format';
import { useI18n, useT, type Lang, type TFunction } from '@/lib/i18n';
import { sportColorVar, sportLabel } from '@/lib/sports';
import { todayKey } from '@/lib/time';
import { chartLegend, clockAxis, dayMs, hitLayer, localMs, timeAxisLabel } from '../chart';
import { speedLabel } from '../format';
import { scopedTop, type RecordScope } from '../periods';
import { ActivityLink, ChartSkeleton } from './common';

export type { RecordScope };

export function effortLabel(sport: string, effort: string, lang: Lang): string {
  return BEST_EFFORTS[sport]?.find((d) => d.key === effort)?.label[lang] ?? effort;
}

// ---------------------------------------------------------------------------
// Personal records table
// ---------------------------------------------------------------------------

export function EffortsCard({
  sport,
  efforts,
  scope,
  selected,
  onSelect,
}: {
  sport: string;
  efforts: ProgressEffortRow[];
  scope: RecordScope;
  selected: string | null;
  onSelect: (effort: string) => void;
}) {
  const t = useT();
  const fmt = useFormat();
  const { lang } = useI18n();
  const any = efforts.some((e) => e.attempts > 0);
  return (
    <Card className="min-w-0">
      <CardHeader
        title={t('progress.records.table.title')}
        subtitle={t('progress.records.table.subtitle', { scope: t(`progress.records.scope.${scope}`) })}
        icon={Trophy}
      />
      {!any ? (
        <EmptyState icon={Trophy} title={t('progress.records.noEfforts')} description={t('progress.records.noEffortsHint')} />
      ) : (
        <Table>
          <thead>
            <tr>
              <TH>{t('progress.records.table.distance')}</TH>
              <TH numeric>{t('progress.records.table.time')}</TH>
              <TH numeric>{speedLabel(t, sport)}</TH>
              <TH>{t('progress.records.table.date')}</TH>
              {/* /records counts the attempts of all time only */}
              <TH numeric>{t(scope === 'allTime' ? 'progress.records.table.attempts' : 'progress.records.table.attemptsAllTime')}</TH>
            </tr>
          </thead>
          <tbody>
            {efforts.map((e) => {
              const r = e[scope];
              const isPr = scope !== 'allTime' && r && e.allTime && r.workoutId === e.allTime.workoutId;
              const active = selected === e.effort;
              return (
                <tr key={e.effort} className={cn(active && 'bg-accent-soft', e.attempts > 0 && 'cursor-pointer hover:bg-surface-2')} onClick={() => e.attempts > 0 && onSelect(e.effort)}>
                  <TD className="text-fg">
                    {e.attempts > 0 ? (
                      <button
                        type="button"
                        aria-pressed={active}
                        aria-label={`${effortLabel(sport, e.effort, lang)} – ${t('progress.records.table.select')}`}
                        className="font-medium text-fg hover:text-accent-fg"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onSelect(e.effort);
                        }}
                      >
                        {effortLabel(sport, e.effort, lang)}
                      </button>
                    ) : (
                      <span className="text-fg-3">{effortLabel(sport, e.effort, lang)}</span>
                    )}
                  </TD>
                  <TD numeric className={r ? 'font-semibold text-fg' : undefined}>
                    {r ? fmt.duration(r.elapsedS) : '–'}
                  </TD>
                  <TD numeric>{r ? fmt.pace(e.distanceM / r.elapsedS, sport) : '–'}</TD>
                  <TD>
                    {r ? (
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <Link
                          to={`/activities/${r.workoutId}`}
                          onClick={(ev) => ev.stopPropagation()}
                          className="text-fg-2 hover:text-accent-fg hover:underline"
                          title={workoutTitle(r, lang)}
                        >
                          {fmt.date(r.startTs, r.tzMin, 'day')}
                        </Link>
                        {isPr && (
                          <Badge tone="accent" icon={Medal}>
                            {t('progress.records.table.allTimePr')}
                          </Badge>
                        )}
                      </span>
                    ) : (
                      '–'
                    )}
                  </TD>
                  <TD numeric>{e.attempts ? fmt.int(e.attempts) : '–'}</TD>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Progression of one distance
// ---------------------------------------------------------------------------

function progressionOption(
  h: ProgressEffortHistory,
  o: { theme: ChartTheme; fmt: Formatter; t: TFunction; lang: Lang; names: { attempts: string; pr: string } },
): EChartsOption {
  const { theme, fmt, t, lang, names } = o;
  const color = sportColor(theme, h.sport);
  const xs = h.attempts.map((a) => localMs(a.startTs, a.tzMin));
  const pts = h.attempts.map((a, i) => ({
    value: [xs[i]!, Math.round(a.elapsedS * 10) / 10],
    attempt: i,
    symbolSize: a.pr ? 10 : 7,
    itemStyle: a.pr ? { color, opacity: 1, borderColor: theme.surface, borderWidth: 2 } : undefined,
  }));
  // running personal record as a step line, held until today
  const steps: number[][] = [];
  h.attempts.forEach((a, i) => {
    if (a.pr) steps.push([xs[i]!, a.elapsedS]);
  });
  if (steps.length) steps.push([Math.max(xs.at(-1)!, dayMs(todayKey())), steps.at(-1)![1]!]);
  const span = xs.length ? (dayMs(todayKey()) - xs[0]!) / 86_400_000 : 0;
  return {
    useUTC: true,
    grid: grid({ top: 40 }),
    legend: chartLegend(theme, 'line', {
      data: [{ name: names.attempts, icon: 'circle', itemStyle: { color, opacity: 0.6, borderWidth: 0 } }, { name: names.pr }],
    }),
    xAxis: timeAxis(theme, { axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: timeAxisLabel(fmt, span) } }),
    yAxis: valueAxis(theme, {
      inverse: true,
      ...clockAxis(h.attempts.map((a) => a.elapsedS)),
      axisLabel: { color: theme.muted, fontSize: 11, formatter: (n: number) => clock(n) },
    }),
    tooltip: itemTooltip(theme, (p: unknown) => {
      const i = (p as { data?: { attempt?: number } }).data?.attempt;
      if (i === undefined) return '';
      const a = h.attempts[i]!;
      const rows = [
        { color, label: t('progress.records.table.time'), value: fmt.duration(a.elapsedS) },
        { color: 'transparent', label: speedLabel(t, h.sport), value: fmt.pace(h.distanceM / a.elapsedS, h.sport) },
      ];
      if (a.pr) rows.push({ color: 'transparent', label: '', value: t('progress.records.progression.newPr') });
      return tooltipHtml(`${workoutTitle(a, lang)} · ${fmt.date(a.startTs, a.tzMin, 'day')}`, rows, theme);
    }),
    series: [
      scatterSeries(theme, names.attempts, pts, color, {
        itemStyle: { color, opacity: 0.45, borderColor: theme.surface, borderWidth: 1 },
        emphasis: { scale: 1.4, itemStyle: { opacity: 1 } },
      }),
      lineSeries(theme, names.pr, steps, theme.fg, { step: 'end', silent: true, z: 4 }),
      hitLayer('hit', pts.map((p) => ({ value: p.value, attempt: p.attempt }))),
    ],
  } as EChartsOption;
}

export function ProgressionCard({
  sport,
  effort,
  history,
  loading,
  error,
}: {
  sport: string;
  effort: string | null;
  history: ProgressEffortHistory | undefined;
  loading: boolean;
  error: unknown;
}) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const { lang } = useI18n();
  const navigate = useNavigate();
  const names = useMemo(
    () => ({ attempts: t('progress.records.progression.attempts'), pr: t('progress.records.progression.pr') }),
    [t],
  );
  // the previous distance stays visible (dimmed) while the next one loads
  const h = history;
  const option = useMemo(
    () => (h && h.attempts.length ? progressionOption(h, { theme, fmt, t, lang, names }) : null),
    [h, theme, fmt, t, lang, names],
  );
  const onEvents = useMemo(
    () => ({
      click: (p: { data?: { attempt?: number } }) => {
        const i = p.data?.attempt;
        if (i !== undefined && h) navigate(`/activities/${h.attempts[i]!.workoutId}`);
      },
    }),
    [h, navigate],
  );
  const table = useMemo(
    () =>
      h
        ? {
            columns: [
              { key: 'date', label: t('progress.records.table.date') },
              { key: 'activity', label: t('progress.common.activity') },
              { key: 'time', label: t('progress.records.table.time'), numeric: true },
              { key: 'pace', label: speedLabel(t, h.sport), numeric: true },
              { key: 'pr', label: t('progress.records.progression.pr') },
            ],
            rows: [...h.attempts].reverse().map((a) => ({
              date: fmt.date(a.startTs, a.tzMin, 'day'),
              activity: <ActivityLink w={a} />,
              time: fmt.duration(a.elapsedS),
              pace: fmt.pace(h.distanceM / a.elapsedS, h.sport),
              pr: a.pr ? <Medal size={14} className="text-accent-fg" aria-label={t('progress.records.progression.newPr')} /> : '',
            })),
          }
        : undefined,
    [h, fmt, t],
  );
  const label = effort ? effortLabel(sport, effort, lang) : '';
  return (
    <ChartCard
      title={t('progress.records.progression.title', { distance: label })}
      subtitle={t('progress.records.progression.subtitle')}
      icon={LineChartIcon}
      table={option ? table : undefined}
    >
      {error ? (
        <ErrorState error={error} />
      ) : !effort ? (
        <EmptyState title={t('progress.records.noEfforts')} className="h-[300px]" />
      ) : !h ? (
        <ChartSkeleton height={300} />
      ) : !option ? (
        <EmptyState title={t('progress.records.progression.empty')} className="h-[300px]" />
      ) : (
        <EChart option={option} height={300} loading={loading} onEvents={onEvents} ariaLabel={t('progress.records.progression.title', { distance: label })} />
      )}
    </ChartCard>
  );
}

// ---------------------------------------------------------------------------
// Top 10
// ---------------------------------------------------------------------------

export function TopTenCard({
  sport,
  effort,
  history,
  scope,
  error,
}: {
  sport: string;
  effort: string | null;
  history: ProgressEffortHistory | undefined;
  /** The page's period: the fastest attempts of this scope. */
  scope: RecordScope;
  /** The request failed: say so instead of skeleton rows that never end. */
  error: unknown;
}) {
  const t = useT();
  const fmt = useFormat();
  const { lang } = useI18n();
  // the server ranks all time; a period ranks its own attempts (with the same tie rule)
  const top = useMemo(
    () => (!history ? [] : scope === 'allTime' ? history.top : scopedTop(history.attempts, scope, todayKey())),
    [history, scope],
  );
  return (
    <Card className="min-w-0">
      <CardHeader
        title={t('progress.records.top.title', { distance: effort ? effortLabel(sport, effort, lang) : '' })}
        subtitle={t(`progress.records.scope.${scope}`)}
        icon={ListOrdered}
      />
      {error ? (
        <ErrorState error={error} />
      ) : !history ? (
        <div className="grid gap-2">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : !top.length ? (
        <EmptyState title={t(scope === 'allTime' ? 'progress.records.progression.empty' : 'progress.records.top.emptyScope')} />
      ) : (
        <Table>
          <thead>
            <tr>
              <TH>{t('progress.records.top.rank')}</TH>
              <TH numeric>{t('progress.records.table.time')}</TH>
              <TH numeric>{speedLabel(t, sport)}</TH>
              <TH>{t('progress.records.table.date')}</TH>
              <TH numeric>{t('progress.records.top.avgHr')}</TH>
            </tr>
          </thead>
          <tbody>
            {top.map((r) => (
              <tr key={`${r.workoutId}-${r.rank}`}>
                <TD className="text-fg">
                  {r.rank === 1 ? <Medal size={15} className="text-accent-fg" aria-label="1" /> : r.rank}
                </TD>
                <TD numeric className="font-semibold text-fg">
                  {fmt.duration(r.elapsedS)}
                </TD>
                <TD numeric>{fmt.pace(history.distanceM / r.elapsedS, sport)}</TD>
                <TD>
                  <Link to={`/activities/${r.workoutId}`} className="text-fg-2 hover:text-accent-fg hover:underline" title={workoutTitle(r, lang)}>
                    {fmt.date(r.startTs, r.tzMin, 'day')}
                  </Link>
                </TD>
                <TD numeric>{r.avgHr ? fmt.int(r.avgHr) : '–'}</TD>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Highlights (longest, biggest climb, fastest, …)
// ---------------------------------------------------------------------------

const HIGHLIGHT_ICONS: Record<ProgressHighlightKey, typeof Ruler> = {
  longest: Ruler,
  longestTime: Timer,
  climb: Mountain,
  fastest: Zap,
  hardest: Flag,
};

function highlightValue(h: ProgressHighlight, fmt: Formatter, t: TFunction): string {
  switch (h.key) {
    case 'longest':
      return fmt.distance(h.value);
    case 'longestTime':
      return fmt.duration(h.value);
    case 'climb':
      return fmt.elevation(h.value);
    case 'fastest':
      return fmt.pace(h.value, h.workout.sport);
    case 'hardest':
      return t('progress.records.highlights.effortPoints', { value: fmt.int(h.value) });
  }
}

export function HighlightsCard({ sport, highlights }: { sport: string; highlights: ProgressHighlight[] }) {
  const t = useT();
  const fmt = useFormat();
  const { lang } = useI18n();
  if (!highlights.length) return null;
  return (
    <Card className="min-w-0">
      <CardHeader
        title={t('progress.records.highlights.title')}
        // the highlights are all-time bests whatever period the page shows
        subtitle={`${t('progress.records.highlights.subtitle', { sport: sportLabel(sport, lang) })} · ${t('progress.records.scope.allTime')}`}
        icon={Medal}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {highlights.map((h) => {
          const Icon = HIGHLIGHT_ICONS[h.key];
          return (
            <Link
              key={h.key}
              to={`/activities/${h.workout.id}`}
              className="group flex min-w-0 items-center gap-3 rounded-control border border-border p-3 transition-colors hover:bg-surface-2 xl:flex-col xl:items-stretch"
            >
              {h.workout.polyline ? (
                <RouteThumbnail
                  polyline={h.workout.polyline}
                  width={96}
                  height={64}
                  color={sportColorVar(h.workout.sport)}
                  className="h-16 w-24 shrink-0 xl:h-20 xl:w-full"
                  ariaLabel={workoutTitle(h.workout, lang)}
                />
              ) : (
                <span className="grid h-16 w-24 shrink-0 place-items-center rounded-control bg-surface-2 text-fg-3 xl:h-20 xl:w-full">
                  <Icon size={22} aria-hidden />
                </span>
              )}
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-xs font-medium text-fg-3">
                  <Icon size={13} aria-hidden />
                  <span className="truncate">{t(`progress.records.highlights.${h.key}`)}</span>
                </div>
                <div className="mt-0.5 truncate text-lg font-semibold text-fg">{highlightValue(h, fmt, t)}</div>
                <div className="truncate text-xs text-fg-3 group-hover:text-accent-fg">
                  {workoutTitle(h.workout, lang)} · {fmt.date(h.workout.startTs, h.workout.tzMin, 'day')}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Race predictor
// ---------------------------------------------------------------------------

function BasisLine({ b, lang, fmt, t }: { b: ProgressEffortRef & { effort: string }; lang: Lang; fmt: Formatter; t: TFunction }) {
  return (
    <Link to={`/activities/${b.workoutId}`} className="block text-[11px] leading-snug text-fg-3 hover:text-accent-fg hover:underline">
      {t('progress.records.predictor.basis', {
        effort: effortLabel('run', b.effort, lang),
        time: fmt.duration(b.elapsedS),
        date: fmt.date(b.startTs, b.tzMin, 'dayShort'),
      })}
    </Link>
  );
}

export function PredictorCard({ data, error }: { data: ProgressPredictions | undefined; error: unknown }) {
  const t = useT();
  const fmt = useFormat();
  const { lang } = useI18n();
  const any = data?.targets.some((x) => x.riegel || x.vo2max);
  return (
    <Card className="min-w-0">
      <CardHeader title={t('progress.records.predictor.title')} subtitle={t('progress.records.predictor.subtitle')} icon={Flag} />
      {error ? (
        <ErrorState error={error} />
      ) : !data ? (
        <div className="grid gap-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : !any ? (
        <EmptyState icon={Flag} title={t('progress.records.predictor.empty')} />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <TH>{t('progress.records.predictor.distance')}</TH>
                <TH numeric>{t('progress.records.predictor.riegel')}</TH>
                <TH numeric>{t('progress.records.predictor.vo2max')}</TH>
              </tr>
            </thead>
            <tbody>
              {data.targets.map((x) => (
                <tr key={x.key}>
                  <TD className="font-medium text-fg">{effortLabel('run', x.key, lang)}</TD>
                  <TD numeric>
                    {x.riegel ? (
                      <>
                        <div className="font-semibold text-fg">{fmt.duration(x.riegel.elapsedS)}</div>
                        <div className="text-xs text-fg-3">{fmt.pace(x.distanceM / x.riegel.elapsedS, 'run')}</div>
                        <BasisLine b={x.riegel.basis} lang={lang} fmt={fmt} t={t} />
                      </>
                    ) : (
                      '–'
                    )}
                  </TD>
                  <TD numeric>
                    {x.vo2max ? (
                      <>
                        <div className="font-semibold text-fg">{fmt.duration(x.vo2max.elapsedS)}</div>
                        <div className="text-xs text-fg-3">{fmt.pace(x.distanceM / x.vo2max.elapsedS, 'run')}</div>
                      </>
                    ) : (
                      '–'
                    )}
                  </TD>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="mt-3 grid gap-1 text-xs text-fg-3">
            <p>{t('progress.records.predictor.riegelNote', { exponent: fmt.num(data.riegelExponent, 2), days: fmt.int(data.windowDays) })}</p>
            <p>
              {data.vo2max
                ? t('progress.records.predictor.vo2Note', { value: fmt.num(data.vo2max.value, 1), date: fmt.day(data.vo2max.day, 'day') })
                : t('progress.records.predictor.noVo2')}
            </p>
          </div>
        </>
      )}
    </Card>
  );
}
