import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Pencil, Star, Trash2, Trophy, Waypoints, X } from 'lucide-react';
import {
  M_PER_FT,
  sportInfo,
  workoutTitle,
  type MapsSegmentDetail,
  type MapsSegmentEffort,
} from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { areaSeries, axisTooltip, grid, tooltipHtml, valueAxis } from '@/components/charts/options';
import { useChartTheme } from '@/components/charts/theme';
import { overlayColors } from '@/components/map/styles';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  Page,
  PageHeader,
  Skeleton,
  Stat,
  StatRow,
  Table,
  TD,
  TH,
  cn,
} from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useI18n, useT } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { SportBadge, SportIcon, sportColorVar, useSportLabel } from '@/lib/sports';
import { decodePolyline, toLngLat } from '@/lib/polyline';
import { useResolvedTheme } from '@/lib/theme';
import { EffortTrend } from '../components/EffortTrend';
import { LineMap, type MapLine, type MapMarker } from '../components/LineMap';
import { dateHint } from '../lib/dates';
import { unionBox, type BBox } from '../lib/home';
import { gradeAt } from '../lib/segments';

export default function SegmentPage() {
  const t = useT();
  const { id } = useParams();
  const q = useApi<MapsSegmentDetail>(['maps', 'segment', id], id ? `/maps/segments/${id}` : null);
  return (
    <Page wide>
      <div className="mb-3">
        <Link to="/maps/segments">
          <Button variant="ghost" size="sm" icon={ArrowLeft}>
            {t('maps.titles.SegmentsPage')}
          </Button>
        </Link>
      </div>
      {q.isError && <ErrorState error={q.error} />}
      {!q.data && !q.isError && (
        <div className="grid gap-4">
          <Skeleton className="h-10 w-80" />
          <Skeleton className="h-24 w-full rounded-card" />
          <div className="grid gap-4 xl:grid-cols-2">
            <Skeleton className="h-80 rounded-card" />
            <Skeleton className="h-80 rounded-card" />
          </div>
        </div>
      )}
      {q.data && <Body detail={q.data} key={q.data.segment.id} />}
    </Page>
  );
}

function Body({ detail }: { detail: MapsSegmentDetail }) {
  const t = useT();
  const fmt = useFormat();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { segment: s, efforts } = detail;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState(false);

  const patch = async (body: { name?: string; starred?: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/maps/segments/${s.id}`, body);
      await qc.invalidateQueries({ queryKey: ['maps'] });
      setEditing(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.delete(`/maps/segments/${s.id}`);
      await qc.invalidateQueries({ queryKey: ['maps'] });
      navigate('/maps/segments');
    } catch (e) {
      setError(e);
      setBusy(false);
      setConfirm(false);
    }
  };

  const latest = efforts[0];
  const best = efforts.find((e) => e.rank === 1);
  return (
    <div className="grid min-w-0 gap-4">
      <PageHeader
        icon={Waypoints}
        title={
          editing ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim()) void patch({ name: draft.trim() });
              }}
            >
              <Input
                autoFocus
                value={draft}
                maxLength={120}
                aria-label={t('maps.segments.name')}
                onChange={(e) => setDraft(e.target.value)}
                className="h-10 w-72 max-w-full text-lg font-semibold"
              />
              <IconButton
                type="submit"
                icon={Check}
                label={t('common.save')}
                disabled={busy || !draft.trim()}
              />
              <IconButton
                type="button"
                icon={X}
                label={t('common.cancel')}
                onClick={() => setEditing(false)}
              />
            </form>
          ) : (
            s.name
          )
        }
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <SportBadge sport={s.sport} />
            <span aria-hidden>·</span>
            <span className="tabular">{fmt.distance(s.distanceM, 2)}</span>
          </span>
        }
        actions={
          !editing && (
            <>
              <Button
                icon={Star}
                variant={s.starred ? 'primary' : 'secondary'}
                aria-pressed={s.starred}
                disabled={busy}
                onClick={() => void patch({ starred: !s.starred })}
              >
                {s.starred ? t('maps.segments.starred') : t('maps.segments.star')}
              </Button>
              <Button
                icon={Pencil}
                onClick={() => {
                  setDraft(s.name);
                  setEditing(true);
                }}
              >
                {t('maps.routes.rename')}
              </Button>
              <Button icon={Trash2} variant="ghost" onClick={() => setConfirm(true)}>
                {t('common.delete')}
              </Button>
            </>
          )
        }
      />
      {error != null && <ErrorState error={error} />}

      <Card>
        <StatRow>
          <Stat
            label={t('common.distance')}
            value={fmt.distanceParts(s.distanceM, 2).value}
            unit={fmt.distanceUnit}
          />
          <Stat
            label={t('maps.segments.avgGrade')}
            value={s.avgGradePct === null ? '–' : fmt.signed(s.avgGradePct, 1)}
            unit={s.avgGradePct === null ? undefined : '%'}
            hint={
              s.elevationGainM !== null
                ? `${t('common.elevationGain')}: ${fmt.elevation(s.elevationGainM)}`
                : undefined
            }
          />
          <Stat
            label={t('maps.segments.efforts')}
            value={fmt.int(s.efforts)}
            hint={
              latest
                ? `${t('maps.routes.latest')}: ${dateHint(fmt, latest.startTs, latest.tzMin)}`
                : undefined
            }
          />
          <Stat
            label={t('maps.segments.pr')}
            value={s.prTimeS === null ? '–' : fmt.duration(s.prTimeS)}
            hint={s.prTs !== null && s.prTzMin !== null ? fmt.date(s.prTs, s.prTzMin, 'day') : undefined}
          />
        </StatRow>
      </Card>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <SegmentMap detail={detail} />
        <ProfileChart detail={detail} />
      </div>

      {efforts.length === 0 ? (
        <Card>
          <EmptyState
            icon={Trophy}
            title={t('maps.segments.noEfforts')}
            description={t('maps.segments.noEffortsHint')}
          />
        </Card>
      ) : (
        <>
          <EffortTrend
            efforts={efforts.map((e) => ({
              startTs: e.startTs,
              tzMin: e.tzMin,
              timeS: e.elapsedS,
              avgSpeed: e.avgSpeed,
              avgHr: e.avgHr,
              rank: e.rank,
            }))}
            sport={s.sport}
            title={t('maps.segments.trendTitle')}
            subtitle={t('maps.routes.trendSubtitle')}
          />
          <Leaderboard
            efforts={efforts}
            sport={s.sport}
            bestId={best ? `${best.workoutId}:${best.idx}` : null}
          />
        </>
      )}

      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t('maps.segments.deleteTitle')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" icon={Trash2} loading={busy} onClick={() => void remove()}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-2">{t('maps.segments.deleteText', { name: s.name })}</p>
      </Dialog>
    </div>
  );
}

function SegmentMap({ detail }: { detail: MapsSegmentDetail }) {
  const t = useT();
  const { settings } = useSettings();
  const appTheme = useResolvedTheme();
  const chart = useChartTheme();
  const overlay = overlayColors(settings.mapStyle, appTheme);
  const { segment } = detail;
  const { lines, markers, bounds } = useMemo(() => {
    const coords = toLngLat(decodePolyline(segment.polyline));
    let box: BBox | null = null;
    for (const [lo, la] of coords) box = unionBox(box, [lo, la, lo, la]);
    const l: MapLine[] = [
      { id: 'segment', lines: [coords], color: chart.accent, width: 5, casing: overlay.casing },
    ];
    const m: MapMarker[] = [
      { id: 'start', coord: [segment.startLon, segment.startLat], color: chart.status.good, radius: 7 },
      { id: 'end', coord: [segment.endLon, segment.endLat], color: chart.fg, radius: 7 },
    ];
    return { lines: l, markers: m, bounds: box };
  }, [segment, chart, overlay.casing]);
  return (
    <Card padded={false} className="flex min-h-[22rem] flex-col overflow-hidden">
      <LineMap
        className="min-h-[22rem] flex-1 rounded-none"
        lines={lines}
        markers={markers}
        bounds={bounds}
        padding={64}
      >
        <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-lg border border-border bg-surface/90 px-2.5 py-1.5 text-xs text-fg-2 shadow-card backdrop-blur">
          <span className="inline-flex items-center gap-2">
            <span className="size-2.5 rounded-full" style={{ background: chart.status.good }} aria-hidden />
            {t('maps.segments.start')}
          </span>
          <span className="ml-3 inline-flex items-center gap-2">
            <span className="size-2.5 rounded-full" style={{ background: chart.fg }} aria-hidden />
            {t('maps.segments.end')}
          </span>
        </div>
      </LineMap>
    </Card>
  );
}

function ProfileChart({ detail }: { detail: MapsSegmentDetail }) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const { profile } = detail;
  const imperial = fmt.units === 'imperial';
  const hasEle = profile.ele.some((e) => e !== null);
  const eleVal = (m: number) => (imperial ? m / M_PER_FT : m);
  const eleUnit = imperial ? 'ft' : 'm';
  const name = t('maps.segments.elevationProfile');

  const option = useMemo(() => {
    const data = profile.dist.map((d, i) => [
      fmt.distanceValue(d),
      profile.ele[i] == null ? null : eleVal(profile.ele[i]!),
    ]);
    return {
      grid: grid({ top: 12, right: 30 }),
      tooltip: axisTooltip(theme, (params) => {
        const p = (params as { dataIndex: number }[])[0];
        if (!p) return '';
        const d = profile.dist[p.dataIndex]!;
        const e = profile.ele[p.dataIndex];
        const g = gradeAt(profile.dist, profile.ele, d);
        const rows = [{ color: theme.accent, label: name, value: e == null ? '–' : fmt.elevation(e) }];
        if (g !== null)
          rows.push({ color: theme.muted, label: t('maps.segments.grade'), value: `${fmt.signed(g, 1)} %` });
        return tooltipHtml(fmt.distance(d, 2), rows, theme);
      }),
      xAxis: valueAxis(theme, {
        min: 0,
        max: fmt.distanceValue(profile.dist[profile.dist.length - 1] ?? 0),
        splitLine: { show: false },
        axisLine: { show: true, lineStyle: { color: theme.axis } },
        axisLabel: {
          color: theme.muted,
          fontSize: 11,
          formatter: (v: number) => `${fmt.num(v, v < 10 ? 1 : 0)} ${fmt.distanceUnit}`,
        },
      }),
      yAxis: valueAxis(theme, {
        scale: true,
        axisLabel: { color: theme.muted, fontSize: 11, formatter: (v: number) => `${fmt.num(v)} ${eleUnit}` },
      }),
      series: [areaSeries(theme, name, data as never, theme.accent, { showSymbol: false })],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, theme, fmt, name]);

  return (
    <ChartCard
      title={name}
      subtitle={hasEle ? undefined : t('maps.segments.noElevation')}
      table={{
        columns: [
          { key: 'd', label: t('common.distance'), numeric: true },
          { key: 'e', label: t('common.elevation'), numeric: true },
          { key: 'g', label: t('maps.segments.grade'), numeric: true },
        ],
        rows: profile.dist
          .map((d, i) => ({ d, i }))
          .filter(({ i }) => i % Math.max(1, Math.round(profile.dist.length / 40)) === 0)
          .map(({ d, i }) => {
            const g = gradeAt(profile.dist, profile.ele, d);
            return {
              d: fmt.distance(d, 2),
              e: profile.ele[i] == null ? '–' : fmt.elevation(profile.ele[i]!),
              g: g === null ? '–' : `${fmt.signed(g, 1)} %`,
            };
          }),
      }}
    >
      {hasEle ? (
        <EChart option={option as never} height={280} ariaLabel={name} />
      ) : (
        <EmptyState title={t('maps.segments.noElevation')} className="py-16" />
      )}
    </ChartCard>
  );
}

type SortCol = 'rank' | 'date' | 'pace' | 'hr';

function Leaderboard({
  efforts,
  sport,
  bestId,
}: {
  efforts: MapsSegmentEffort[];
  sport: string;
  bestId: string | null;
}) {
  const t = useT();
  const fmt = useFormat();
  const { lang } = useI18n();
  const sportLabel = useSportLabel();
  const [sort, setSort] = useState<{ col: SortCol; dir: 'asc' | 'desc' }>({ col: 'rank', dir: 'asc' });
  const [all, setAll] = useState(false);
  const mixed = new Set(efforts.map((e) => e.sport)).size > 1;
  const rows = useMemo(() => {
    const key = (e: MapsSegmentEffort) =>
      sort.col === 'rank'
        ? e.rank
        : sort.col === 'date'
          ? e.startTs
          : sort.col === 'pace'
            ? e.avgSpeed
            : (e.avgHr ?? 0);
    const list = [...efforts].sort((a, b) => key(a) - key(b) || a.startTs - b.startTs);
    return sort.dir === 'desc' ? list.reverse() : list;
  }, [efforts, sort]);
  const visible = all ? rows : rows.slice(0, 15);
  const th = (col: SortCol, label: string, numeric = false, className?: string) => (
    <TH
      numeric={numeric}
      className={className}
      onClick={() =>
        setSort((s) =>
          s.col === col
            ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' }
            : { col, dir: col === 'date' || col === 'pace' ? 'desc' : 'asc' },
        )
      }
      sorted={sort.col === col ? sort.dir : null}
    >
      {label}
    </TH>
  );
  return (
    <Card padded={false}>
      <div className="p-4 pb-0 sm:p-5 sm:pb-0">
        <CardHeader title={t('maps.segments.leaderboard')} subtitle={t('maps.segments.leaderboardHint')} />
      </div>
      <Table>
        <thead>
          <tr>
            {th('rank', t('maps.routes.rank'), true, 'w-16')}
            {th('date', t('common.day'))}
            <TH numeric>{t('maps.routes.time')}</TH>
            {th('pace', sportInfo(sport).speedMode === 'speed' ? t('common.speed') : t('common.pace'), true)}
            {th('hr', t('common.avgHr'), true)}
          </tr>
        </thead>
        <tbody>
          {visible.map((e) => {
            const isBest = bestId === `${e.workoutId}:${e.idx}`;
            return (
              <tr key={`${e.workoutId}:${e.idx}`} className={cn('hover:bg-surface-2', isBest && 'bg-good/5')}>
                <TD numeric>
                  {isBest ? (
                    <Badge tone="good" icon={Trophy}>
                      {t('maps.segments.prBadge')}
                    </Badge>
                  ) : (
                    <span className="tabular">{e.rank}</span>
                  )}
                </TD>
                <TD>
                  <Link
                    to={`/activities/${e.workoutId}`}
                    className="font-medium text-fg hover:text-accent-fg"
                  >
                    {fmt.date(e.startTs, e.tzMin, 'day')}
                  </Link>
                  <span className="ml-2 text-xs text-fg-3">
                    {fmt.time(e.startTs, e.tzMin)} · {workoutTitle(e, lang)}
                  </span>
                  {mixed && (
                    <span className="ml-2 inline-flex items-center gap-1 text-xs text-fg-3">
                      <span style={{ color: sportColorVar(e.sport) }}>
                        <SportIcon sport={e.sport} size={12} strokeWidth={2.5} />
                      </span>
                      {sportLabel(e.sport)}
                    </span>
                  )}
                  {e.pr && !isBest && (
                    <Badge tone="neutral" className="ml-2" icon={Trophy}>
                      {t('maps.segments.wasPr')}
                    </Badge>
                  )}
                </TD>
                <TD numeric>
                  <span className="font-semibold text-fg">{fmt.duration(e.elapsedS)}</span>
                  {e.movingS !== null && Math.abs(e.movingS - e.elapsedS) >= 5 && (
                    <span className="block text-xs text-fg-3">
                      {t('common.movingTime')} {fmt.duration(e.movingS)}
                    </span>
                  )}
                </TD>
                <TD numeric>{fmt.pace(e.avgSpeed, e.sport)}</TD>
                <TD numeric>{e.avgHr ? fmt.hr(e.avgHr) : '–'}</TD>
              </tr>
            );
          })}
        </tbody>
      </Table>
      {rows.length > 15 && (
        <div className="flex justify-center p-3">
          <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
            {all ? t('common.less') : t('maps.routes.showAllEfforts', { count: rows.length })}
          </Button>
        </div>
      )}
    </Card>
  );
}
