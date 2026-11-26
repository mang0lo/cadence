import { useEffect, useMemo, useState } from 'react';
import { Grid3x3, Info, Maximize2, Target } from 'lucide-react';
import { tileBounds, tileKey, tileToLonLat, type MapsExplorerResponse } from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import {
  areaSeries,
  axisTooltip,
  barSeries,
  categoryAxis,
  grid,
  tooltipHtml,
  valueAxis,
} from '@/components/charts/options';
import { useChartTheme } from '@/components/charts/theme';
import {
  Button,
  Card,
  Delta,
  EmptyState,
  ErrorState,
  FilterBar,
  Hint,
  IconButton,
  Page,
  PageHeader,
  SegmentedControl,
  Select,
  Skeleton,
  Stat,
  StatRow,
  cn,
} from '@/components/ui';
import { useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { sortSports, useSportLabel } from '@/lib/sports';
import { useStoredState } from '@/lib/storage';
import { todayKey } from '@/lib/time';
import { ExplorerMap } from '../components/ExplorerMap';
import {
  DETAIL_MIN_ZOOM,
  RAMPS,
  detailKeys,
  firstVisitBuckets,
  maxVisits,
  nextSquare,
  visitLabels,
  visitSteps,
  type ExplorerColorBy,
} from '../lib/explorerLayers';
import { countVars } from '../lib/counts';
import type { HeatBase } from '../lib/heatmapLayers';
import { homeRegion, type BBox } from '../lib/home';
import { overlayColors } from '@/components/map/styles';
import { useResolvedTheme } from '@/lib/theme';

const BASES: HeatBase[] = ['streets', 'satellite', 'dark'];
type ZoomKey = '14' | '17';
/** Stable "no tiles" (a new [] on every render would make the map redraw its overlays). */
const NO_TILES: { x: number; y: number }[] = [];

/** Edge length in meters of a tile at a zoom level and latitude. */
const tileEdgeM = (z: number, lat: number) => (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

export default function ExplorerPage() {
  const t = useT();
  const fmt = useFormat();
  const sportLabel = useSportLabel();
  const { settings } = useSettings();
  const appTheme = useResolvedTheme();

  const [zoom, setZoom] = useStoredState<ZoomKey>('maps.explorer.zoom', '14');
  const [sport, setSport] = useState('all');
  const [colorBy, setColorBy] = useStoredState<ExplorerColorBy>('maps.explorer.colorBy', 'visits');
  const [base, setBase] = useStoredState<HeatBase>(
    'maps.explorer.base',
    settings.mapStyle === 'satellite' ? 'satellite' : settings.mapStyle === 'dark' ? 'dark' : 'streets',
  );
  const [focus, setFocus] = useState<{ bounds: BBox; nonce: number } | null>(null);
  const [fitNonce, setFitNonce] = useState(0);
  // only whether the map is zoomed out too far for the detail tiles: the page re-renders when that flips, not per pan
  const [belowDetailZoom, setBelowDetailZoom] = useState(true);

  const sportParam = sport === 'all' ? undefined : sport;
  const q14 = useApi<MapsExplorerResponse>(['maps', 'explorer', 14], '/maps/explorer', {
    zoom: 14,
    sport: sportParam,
  });
  const q17 = useApi<MapsExplorerResponse>(
    ['maps', 'explorer', 17],
    '/maps/explorer',
    { zoom: 17, sport: sportParam },
    { enabled: zoom === '17' },
  );
  const data14 = q14.data;
  const shown = zoom === '17' ? (q17.data ?? null) : (data14 ?? null);
  const z = Number(zoom) as 14 | 17;

  const tiles = data14?.tiles;
  const buckets = useMemo(() => firstVisitBuckets(tiles ?? []), [tiles]);
  const steps = useMemo(() => visitSteps(maxVisits(tiles ?? [])), [tiles]);
  const visited = useMemo(() => new Set((tiles ?? []).map((x) => tileKey(x.x, x.y))), [tiles]);
  const detail = useMemo(
    () => (q17.data?.compact ? detailKeys(q17.data.compact.x, q17.data.compact.y) : null),
    [q17.data],
  );
  const square = shown?.maxSquare ?? null;
  const next = useMemo(() => (z === 14 && square ? nextSquare(visited, square) : null), [z, square, visited]);

  // entering the detail view: fly to the max square (zoom-17 tiles only show from map zoom 12)
  const sq17 = q17.data?.maxSquare ?? null;
  useEffect(() => {
    if (zoom === '17' && sq17) {
      const pad = Math.max(2, sq17.size);
      setFocus({
        bounds: tileBounds(sq17.x - pad, sq17.y - pad, 17, sq17.size + 2 * pad, sq17.size + 2 * pad),
        nonce: Date.now(),
      });
    }
    if (zoom === '14') setFocus(null);
  }, [zoom, sq17?.x, sq17?.y, sq17?.size]); // eslint-disable-line react-hooks/exhaustive-deps

  // map view: the "home region" of the tiles (a trip abroad does not zoom out to the world)
  const home = useMemo(
    () =>
      homeRegion(
        tiles ?? [],
        (x) => tileToLonLat(x.x, x.y, 14),
        (x) => tileBounds(x.x, x.y, 14),
      ),
    [tiles],
  );
  const bounds = focus?.bounds ?? home ?? data14?.bounds ?? null;
  const centerLat = bounds ? (bounds[1] + bounds[3]) / 2 : 48;

  const base0 = overlayColors(base, appTheme).darkBase;
  const nowMonth = todayKey().slice(0, 7);
  const months = shown?.months ?? [];
  const cur = months.find((m) => m.month === nowMonth)?.newTiles ?? 0;
  const prevMonth = months.find((m) => m.month === prevMonthKey(nowMonth))?.newTiles ?? 0;

  const sports = useMemo(() => {
    const list = data14?.sports ?? [];
    const order = sortSports(list.map((s) => s.sport));
    return [
      { value: 'all', label: t('common.allSports') },
      ...order.map((s) => ({ value: s, label: sportLabel(s) })),
    ];
  }, [data14?.sports, t, sportLabel]);

  const legendLabels = useMemo(
    () =>
      colorBy === 'visits'
        ? visitLabels(steps)
        : buckets.ranges.map((r) => {
            const a = fmt.date(r.fromTs, r.fromTz, 'monthYearShort');
            const b = fmt.date(r.toTs, r.toTz, 'monthYearShort');
            return a === b ? a : `${a} – ${b}`;
          }),
    [colorBy, steps, buckets, fmt],
  );

  const empty = !!data14 && data14.totals.tiles === 0 && sport === 'all';
  const mapHeight = 'h-[clamp(420px,calc(100vh-22rem),780px)]';

  return (
    <Page wide>
      <PageHeader
        icon={Grid3x3}
        title={t('maps.titles.ExplorerPage')}
        subtitle={t('maps.explorer.subtitle')}
        actions={
          !empty && (
            <>
              <div className="w-44 [&>select]:w-full">
                <Select value={sport} onChange={setSport} options={sports} aria-label={t('common.sport')} />
              </div>
              <SegmentedControl
                label={t('maps.explorer.zoomLabel')}
                value={zoom}
                onChange={setZoom}
                items={[
                  { value: '14', label: t('maps.explorer.zoom14') },
                  { value: '17', label: t('maps.explorer.zoom17') },
                ]}
              />
            </>
          )
        }
      />

      {q14.isError && <ErrorState error={q14.error} />}
      {zoom === '17' && q17.isError && <ErrorState error={q17.error} className="mt-2" />}

      {empty && (
        <Card>
          <EmptyState
            icon={Grid3x3}
            title={t('maps.explorer.empty')}
            description={t('maps.explorer.emptyHint')}
          />
        </Card>
      )}

      {!empty && (
        <div className="grid min-w-0 gap-4">
          <Card>
            {shown ? (
              <StatRow>
                <Stat
                  label={t('maps.explorer.stats.tiles')}
                  value={fmt.int(shown.totals.tiles)}
                  hint={t('maps.explorer.tileSize', {
                    size:
                      z === 14
                        ? fmt.distance(tileEdgeM(14, centerLat), 1)
                        : fmt.shortDistance(tileEdgeM(17, centerLat)),
                  })}
                />
                <Stat
                  label={t('maps.explorer.stats.maxSquare')}
                  value={
                    shown.totals.maxSquare ? `${shown.totals.maxSquare} × ${shown.totals.maxSquare}` : '–'
                  }
                  hint={t('maps.explorer.stats.maxSquareHint', countVars(fmt, shown.totals.maxSquare ** 2))}
                />
                <Stat
                  label={t('maps.explorer.stats.maxCluster')}
                  value={fmt.int(shown.totals.maxCluster)}
                  hint={
                    <Hint content={t('maps.explorer.stats.maxClusterHelp')}>
                      <span className="inline-flex items-center gap-1">
                        {t('maps.explorer.stats.maxClusterHint', countVars(fmt, shown.totals.interior))}
                        <Info size={12} aria-hidden />
                      </span>
                    </Hint>
                  }
                />
                <Stat
                  label={t('maps.explorer.stats.newThisMonth')}
                  value={fmt.int(cur)}
                  delta={
                    months.length > 0 && cur !== prevMonth ? (
                      <Delta value={cur - prevMonth} text={fmt.signed(cur - prevMonth)} />
                    ) : undefined
                  }
                  hint={t('maps.explorer.stats.vsLastMonth')}
                />
              </StatRow>
            ) : (
              <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i}>
                    <Skeleton className="mb-2 h-3 w-20" />
                    <Skeleton className="h-7 w-16" />
                  </div>
                ))}
              </div>
            )}
          </Card>

          <FilterBar className="justify-between gap-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {z === 14 && (
                <SegmentedControl
                  label={t('maps.explorer.colorBy.label')}
                  value={colorBy}
                  onChange={setColorBy}
                  items={[
                    { value: 'visits', label: t('maps.explorer.colorBy.visits') },
                    { value: 'first', label: t('maps.explorer.colorBy.first') },
                  ]}
                />
              )}
              <SegmentedControl
                label={t('maps.heatmap.basemap')}
                value={base}
                onChange={setBase}
                items={BASES.map((k) => ({ value: k, label: t(`maps.heatmap.bases.${k}`) }))}
              />
            </div>
            {z === 14 && next && next.missing.length > 0 && (
              <div className="flex min-w-0 items-center gap-2 text-sm text-fg-2">
                <Target size={16} className="shrink-0 text-accent-fg" aria-hidden />
                <span className="min-w-0">
                  {t('maps.explorer.next.text', countVars(fmt, next.missing.length, { size: next.size }))}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setFocus({
                      bounds: tileBounds(next.x - 1, next.y - 1, 14, next.size + 2, next.size + 2),
                      nonce: Date.now(),
                    })
                  }
                >
                  {t('maps.explorer.next.show')}
                </Button>
              </div>
            )}
          </FilterBar>

          {!data14 ? (
            <Skeleton className={cn('w-full rounded-card', mapHeight)} />
          ) : (
            <ExplorerMap
              className={cn('w-full', mapHeight)}
              zoom={z}
              tiles={data14.tiles}
              buckets={buckets}
              steps={steps}
              detail={detail}
              square={square}
              next={z === 14 && next ? next.missing : NO_TILES}
              colorBy={colorBy}
              base={base}
              bounds={bounds}
              fitNonce={(focus?.nonce ?? 0) + fitNonce}
              onZoomChange={(mapZoom) => setBelowDetailZoom(mapZoom < DETAIL_MIN_ZOOM)}
            >
              <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col items-start gap-1.5">
                {z === 14 ? (
                  <Legend
                    title={
                      colorBy === 'visits'
                        ? t('maps.explorer.legend.visits')
                        : t('maps.explorer.legend.first')
                    }
                    ramp={(colorBy === 'visits' ? RAMPS.orange : RAMPS.blue)[base0 ? 'dark' : 'light']}
                    labels={legendLabels}
                    firstMode={colorBy === 'first'}
                  />
                ) : (
                  belowDetailZoom && (
                    <div className="rounded-lg border border-border bg-surface/90 px-2.5 py-1.5 text-xs text-fg-2 shadow-card backdrop-blur">
                      {t('maps.explorer.detailHint')}
                    </div>
                  )
                )}
                {z === 17 && q17.isFetching && !q17.data && (
                  <div className="rounded-lg bg-surface/90 px-2 py-1 text-xs text-fg-3">
                    {t('common.loading')}
                  </div>
                )}
              </div>
              <div className="absolute right-3 top-3 z-10">
                <IconButton
                  icon={Maximize2}
                  label={t('maps.heatmap.fit')}
                  onClick={() => {
                    setFocus(null);
                    setFitNonce((n) => n + 1);
                  }}
                  className="border border-border bg-surface shadow-card"
                />
              </div>
            </ExplorerMap>
          )}

          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <MonthChart kind="new" months={months} loading={!shown} />
            <MonthChart kind="total" months={months} loading={!shown} />
          </div>
        </div>
      )}
    </Page>
  );
}

const prevMonthKey = (m: string): string => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
};

function Legend({
  title,
  ramp,
  labels,
  firstMode,
}: {
  title: string;
  ramp: readonly string[];
  labels: string[];
  firstMode: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface/90 px-2.5 py-2 text-xs text-fg-2 shadow-card backdrop-blur">
      <div className="mb-1 font-medium text-fg">{title}</div>
      <ul className="space-y-0.5">
        {labels.map((l, i) => (
          <li key={i} className="flex items-center gap-2">
            <span
              className="size-3 rounded-[3px] border border-border"
              style={{ background: ramp[i], opacity: 0.85 }}
              aria-hidden
            />
            <span className="tabular">{l}</span>
          </li>
        ))}
      </ul>
      {firstMode && <div className="sr-only">{title}</div>}
    </div>
  );
}

function MonthChart({
  kind,
  months,
  loading,
}: {
  kind: 'new' | 'total';
  months: { month: string; newTiles: number; total: number }[];
  loading: boolean;
}) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const name = kind === 'new' ? t('maps.explorer.charts.newTiles') : t('maps.explorer.charts.visited');
  const value = (m: { newTiles: number; total: number }) => (kind === 'new' ? m.newTiles : m.total);

  const option = useMemo(() => {
    const labels = months.map((m) => m.month);
    return {
      grid: grid({ top: 12 }),
      tooltip: axisTooltip(theme, (params) => {
        const p = (params as { dataIndex: number }[])[0];
        const m = p ? months[p.dataIndex] : undefined;
        if (!m) return '';
        return tooltipHtml(
          fmt.day(`${m.month}-01`, 'month'),
          [{ color: theme.accent, label: name, value: fmt.int(value(m)) }],
          theme,
        );
      }),
      xAxis: categoryAxis(theme, labels, {
        axisLabel: {
          color: theme.muted,
          hideOverlap: true,
          fontSize: 11,
          formatter: (v: string) => fmt.day(`${v}-01`, 'monthYearShort'),
        },
        axisPointer: { type: 'line' },
      }),
      yAxis: valueAxis(theme, { minInterval: 1 }),
      series: [
        kind === 'new'
          ? barSeries(theme, name, months.map(value), theme.accent)
          : areaSeries(theme, name, months.map(value), theme.accent),
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [months, theme, fmt, name, kind]);

  return (
    <ChartCard
      title={kind === 'new' ? t('maps.explorer.charts.newPerMonth') : t('maps.explorer.charts.overTime')}
      table={{
        columns: [
          { key: 'month', label: t('common.month') },
          { key: 'v', label: name, numeric: true },
          ...(kind === 'new'
            ? [{ key: 'total', label: t('maps.explorer.charts.visited'), numeric: true }]
            : []),
        ],
        rows: months.map((m) => ({
          month: fmt.day(`${m.month}-01`, 'month'),
          v: fmt.int(value(m)),
          total: fmt.int(m.total),
        })),
      }}
    >
      {loading ? (
        <Skeleton className="h-60 w-full" />
      ) : (
        <EChart option={option as never} height={240} ariaLabel={name} />
      )}
    </ChartCard>
  );
}
