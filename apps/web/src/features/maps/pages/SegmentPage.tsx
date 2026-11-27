import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Pencil, Star, Trash2, Trophy, Waypoints, X } from 'lucide-react';
import { M_PER_FT, type MapsSegmentDetail } from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { areaSeries, axisTooltip, grid, tooltipHtml, valueAxis } from '@/components/charts/options';
import { useChartTheme } from '@/components/charts/theme';
import {
  Button,
  Card,
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
} from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { SportBadge } from '@/lib/sports';
import { decodePolyline, toLngLat } from '@/lib/polyline';
import { EffortTable, type EffortRow } from '../components/EffortTable';
import { EffortTrend } from '../components/EffortTrend';
import { LineMap, useShownOverlayColors, type MapLine, type MapMarker } from '../components/LineMap';
import { unionBox, type BBox } from '../lib/home';
import { distanceAxisLabel, gradeAt } from '../lib/segments';

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
  const rows = useMemo<EffortRow[]>(() => {
    const best = efforts.find((e) => e.rank === 1);
    return efforts.map((e) => ({
      key: `${e.workoutId}:${e.idx}`,
      workoutId: e.workoutId,
      name: e.name,
      sport: e.sport,
      startTs: e.startTs,
      tzMin: e.tzMin,
      timeS: e.elapsedS,
      movingS: e.movingS,
      avgSpeed: e.avgSpeed,
      avgHr: e.avgHr,
      rank: e.rank,
      best: e === best,
      pr: e.pr,
    }));
  }, [efforts]);
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
                ? `${t('maps.routes.latest')}: ${fmt.dateHint(latest.startTs, latest.tzMin)}`
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
          <EffortTable
            title={t('maps.segments.leaderboard')}
            subtitle={t('maps.segments.leaderboardHint')}
            rows={rows}
            sport={s.sport}
            bestLabel={t('maps.segments.prBadge')}
            leaderboard
            initialSort={{ col: 'rank', dir: 'asc' }}
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
  const chart = useChartTheme();
  const [overlay, onStylePref] = useShownOverlayColors();
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
        onStylePref={onStylePref}
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
    const maxDist = fmt.distanceValue(profile.dist[profile.dist.length - 1] ?? 0);
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
        max: maxDist,
        splitLine: { show: false },
        axisLine: { show: true, lineStyle: { color: theme.axis } },
        axisLabel: {
          color: theme.muted,
          fontSize: 11,
          // short segments step by 0.03 km (two decimals); the end, the segment's length, keeps apart from the last step
          formatter: distanceAxisLabel(fmt, maxDist),
        },
      }),
      yAxis: valueAxis(theme, {
        scale: true,
        minInterval: 1, // whole m / ft like the labels: a flat segment read '166 m, 166 m, 165 m, 165 m'
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
