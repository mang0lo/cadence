import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Marker, type LngLatBoundsLike, type Map } from 'maplibre-gl';
import { useChartTheme } from '@/components/charts/theme';
import { BaseMap } from '@/components/map/BaseMap';
import { lineFeature, setGeoJSON } from '@/components/map/layers';
import { overlayColors } from '@/components/map/styles';
import { useI18n } from '@/lib/i18n';
import type { Store } from '@/lib/store';
import { useResolvedTheme } from '@/lib/theme';
import { positionAt, replayAt, type Alignment } from '../../lib/compare';
import type { Playback } from '../../lib/playback';
import type { RouteGeometry } from '../../lib/route';
import { fracIndex, haversine, type Prepared } from '../../lib/streams';
import { DOT, START_HTML, currentPref, markerEl } from '../detail/ActivityMap';

type Side = 'a' | 'b';
/** DOM colors of A and B (the map layers use the resolved chart theme colors of the same slots). */
export const SIDE_VAR: Record<Side, string> = { a: 'var(--series-1)', b: 'var(--series-2)' };

/** Room for the legend (top left) and the map controls. */
const FIT_PADDING = { top: 76, bottom: 40, left: 48, right: 52 };
const layerId = (side: Side, part: number) => `cmp-${side}-p${part}`;

function union(a: RouteGeometry['bounds'], b: RouteGeometry['bounds']): [number, number, number, number] {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function letterDot(side: Side, title: string): HTMLDivElement {
  return markerEl(
    {
      ...DOT,
      width: '24px',
      height: '24px',
      background: SIDE_VAR[side],
      display: 'grid',
      placeItems: 'center',
      color: '#fff',
      font: '700 12px/1 var(--font-sans, system-ui)',
      pointerEvents: 'none',
    },
    side.toUpperCase(),
    title,
  );
}

function ring(side: Side): HTMLDivElement {
  const el = markerEl({
    ...DOT,
    width: '14px',
    height: '14px',
    background: '#fff',
    border: `3.5px solid ${SIDE_VAR[side]}`,
    pointerEvents: 'none',
  });
  el.style.visibility = 'hidden';
  return el;
}

export interface CompareMapProps {
  A: Prepared;
  B: Prepared;
  geoA: RouteGeometry;
  geoB: RouteGeometry;
  al: Alignment;
  playback: Playback;
  /** Hovered position on the charts' x axis (m in distance alignment), null = none. */
  hover: Store<number | null>;
  names: Record<Side, string>;
}

/**
 * Both routes on one map (A on top of a wider B, so a shared route shows both colors; track parts are separate lines)
 * with a synchronized replay: one lettered dot per activity on the common clock, plus rings at the hovered distance.
 */
export function CompareMap({ A, B, geoA, geoB, al, playback, hover, names }: CompareMapProps) {
  const { t } = useI18n();
  const theme = useChartTheme();
  const resolved = useResolvedTheme();
  const colorsRef = useRef({ a: theme.series[0]!, b: theme.series[1]!, resolved });
  colorsRef.current = { a: theme.series[0]!, b: theme.series[1]!, resolved };
  const bounds = useMemo(() => union(geoA.bounds, geoB.bounds), [geoA, geoB]);
  const mapRef = useRef<Map | null>(null);
  const markers = useRef<{ a: Marker; b: Marker; ha: Marker; hb: Marker } | null>(null);
  const frame = useRef<number | null>(null);

  const render = useCallback(() => {
    frame.current = null;
    const m = markers.current;
    if (!m) return;
    const r = replayAt(A, B, al, playback.time.get());
    const pa = positionAt(A, r.iA);
    const pb = positionAt(B, r.iB);
    if (pa) m.a.setLngLat(pa);
    if (pb) m.b.setLngLat(pb);
    const h = hover.get();
    const show = (mk: Marker, P: Prepared) => {
      const el = mk.getElement();
      const pos = h !== null && P.dist ? positionAt(P, fracIndex(P.dist, h)) : null;
      if (pos) mk.setLngLat(pos);
      el.style.visibility = pos ? 'visible' : 'hidden';
    };
    show(m.ha, A);
    show(m.hb, B);
  }, [A, B, al, playback, hover]);

  const request = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(render);
  }, [render]);

  useEffect(() => {
    const u = [playback.time.subscribe(request), playback.state.subscribe(request), hover.subscribe(request)];
    request();
    return () => {
      u.forEach((f) => f());
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [playback, hover, request]);

  // called again after every basemap or light/dark switch, with the colors of the new theme
  const onStyleLoad = useCallback(
    (map: Map) => {
      const c = colorsRef.current;
      const { casing } = overlayColors(currentPref(map), c.resolved);
      const sides: [Side, RouteGeometry][] = [
        ['b', geoB],
        ['a', geoA],
      ];
      for (const [side, g] of sides)
        g.parts.forEach((p, i) => setGeoJSON(map, layerId(side, i), lineFeature(g.coords.slice(p.v0, p.v1 + 1))));
      // bottom → top: B casing, A casing, B line (wide), A line (narrow): where both share the road A runs inside B
      const add = (side: Side, g: RouteGeometry, kind: 'casing' | 'line') =>
        g.parts.forEach((_, i) => {
          const id = layerId(side, i);
          const lid = kind === 'casing' ? `${id}-casing` : id;
          if (map.getLayer(lid)) return;
          map.addLayer({
            id: lid,
            type: 'line',
            source: id,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint:
              kind === 'casing'
                ? { 'line-color': casing, 'line-width': side === 'b' ? 10 : 7 }
                : { 'line-color': side === 'a' ? c.a : c.b, 'line-width': side === 'b' ? 7 : 3.5 },
          });
        });
      add('b', geoB, 'casing');
      add('a', geoA, 'casing');
      add('b', geoB, 'line');
      add('a', geoA, 'line');
      request();
    },
    [geoA, geoB, request],
  );

  const onReady = useCallback(
    (map: Map) => {
      mapRef.current = map;
      map.resize();
      map.fitBounds(bounds as LngLatBoundsLike, { padding: FIT_PADDING, maxZoom: 16, animate: false });
      const startEl = () =>
        markerEl({ ...DOT, background: 'var(--good)', display: 'grid', placeItems: 'center' }, START_HTML, t('activities.map.start'));
      const finishEl = () =>
        markerEl(
          { ...DOT, background: 'repeating-conic-gradient(#111 0 25%, #fff 0 50%) 50% / 7px 7px' },
          '',
          t('activities.map.finish'),
        );
      const a0 = geoA.coords[0]!;
      const a1 = geoA.coords[geoA.coords.length - 1]!;
      const b0 = geoB.coords[0]!;
      const b1 = geoB.coords[geoB.coords.length - 1]!;
      const far = (p: [number, number], q: [number, number]) => haversine(p[1], p[0], q[1], q[0]) > 60;
      new Marker({ element: startEl() }).setLngLat(a0).addTo(map);
      new Marker({ element: finishEl() }).setLngLat(a1).addTo(map);
      if (far(a0, b0)) new Marker({ element: startEl() }).setLngLat(b0).addTo(map);
      if (far(a1, b1)) new Marker({ element: finishEl() }).setLngLat(b1).addTo(map);
      const hb = new Marker({ element: ring('b') }).setLngLat(b0).addTo(map);
      const ha = new Marker({ element: ring('a') }).setLngLat(a0).addTo(map);
      const b = new Marker({ element: letterDot('b', names.b) }).setLngLat(b0).addTo(map);
      const a = new Marker({ element: letterDot('a', names.a) }).setLngLat(a0).addTo(map);
      markers.current = { a, b, ha, hb };
      request();
    },
    [bounds, geoA, geoB, names, request, t],
  );

  return (
    <BaseMap className="h-[min(62vh,520px)] min-h-72" bounds={bounds} onReady={onReady} onStyleLoad={onStyleLoad}>
      <div
        className="pointer-events-none absolute left-2 top-2 z-10 max-w-[70%] rounded-[10px] border border-border bg-surface/90 px-2.5 py-1.5 text-[11px] text-fg-2 shadow-card backdrop-blur"
        role="img"
        aria-label={t('activities.compare.legend')}
      >
        {(['a', 'b'] as const).map((side) => (
          <span key={side} className="flex min-w-0 items-center gap-1.5">
            <span className="h-1 w-3.5 shrink-0 rounded-full" style={{ background: SIDE_VAR[side] }} />
            <span className="truncate">{names[side]}</span>
          </span>
        ))}
      </div>
    </BaseMap>
  );
}
