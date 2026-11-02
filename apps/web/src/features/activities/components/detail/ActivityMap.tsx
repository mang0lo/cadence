import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Marker, type GeoJSONSource, type LngLatBoundsLike, type Map, type MapMouseEvent } from 'maplibre-gl';
import { Camera, Palette, Split } from 'lucide-react';
import { M_PER_KM, M_PER_MI, type MapStylePref } from '@cadence/shared';
import { useChartTheme } from '@/components/charts/theme';
import { BaseMap } from '@/components/map/BaseMap';
import { addRouteLayers, featureCollection, gradientExpression, lineFeature, setGeoJSON } from '@/components/map/layers';
import { overlayColors } from '@/components/map/styles';
import { SegmentedControl, cn } from '@/components/ui';
import { clock, useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useResolvedTheme, type ResolvedTheme } from '@/lib/theme';
import { useStoredState } from '@/lib/storage';
import { isPaceSport } from '../../lib/display';
import type { Playback } from '../../lib/playback';
import {
  availableModes,
  coordsByPart,
  partOfVertex,
  partStops,
  routeChunks,
  routeColoring,
  vertexAfter,
  type ColorMode,
  type Legend,
  type RouteGeometry,
} from '../../lib/route';
import type { Store } from '../../lib/store';
import { headingAt, indexAtDist, indexAtTime, lerpAngle, lngLatAt, valueAt, type Prepared } from '../../lib/streams';

export type CameraMode = 'overview' | 'follow' | 'flyover';

const SRC = { route: 'act-route', done: 'act-done', head: 'act-head', sel: 'act-sel' } as const;
/** Source/layer id of a track part's route line (part 0 keeps the plain id). */
const routeId = (part: number) => (part ? `${SRC.route}-p${part}` : SRC.route);
/** Room for the legend (top) and the map controls (bottom). */
const FIT_PADDING = { top: 64, bottom: 40, left: 40, right: 48 };

/** Style preference of the basemap currently shown (the BaseMap switcher may differ from the setting). */
function currentPref(map: Map): MapStylePref {
  const style = map.getStyle();
  if (style?.sources && 'imagery' in style.sources) return 'satellite';
  const name = (style?.name ?? '').toLowerCase();
  if (name.includes('dark')) return 'dark';
  if (name.includes('liberty')) return 'outdoor';
  return 'streets';
}

function markerEl(style: Partial<CSSStyleDeclaration>, html = '', title?: string): HTMLDivElement {
  const el = document.createElement('div');
  Object.assign(el.style, style);
  el.innerHTML = html;
  if (title) {
    el.title = title;
    el.setAttribute('aria-label', title);
    el.setAttribute('role', 'img');
  }
  return el;
}

const DOT: Partial<CSSStyleDeclaration> = {
  width: '16px',
  height: '16px',
  borderRadius: '50%',
  border: '2.5px solid #fff',
  boxShadow: '0 1px 4px rgba(0,0,0,.35)',
  boxSizing: 'border-box',
};

/** Start: green with a play triangle; finish: checkered flag pattern (shape, not only color). */
const START_HTML =
  '<svg width="11" height="11" viewBox="0 0 10 10" style="display:block;margin:0 auto" aria-hidden="true"><path d="M3 2 L8 5 L3 8 Z" fill="#fff"/></svg>';

function kmEl(label: string): HTMLDivElement {
  const el = markerEl({
    minWidth: '17px',
    height: '17px',
    padding: '0 3px',
    borderRadius: '9px',
    background: 'var(--surface)',
    color: 'var(--fg)',
    border: '1px solid var(--border-strong)',
    boxShadow: 'var(--shadow)',
    font: '600 10px/15px var(--font-sans, system-ui)',
    textAlign: 'center',
    boxSizing: 'border-box',
    pointerEvents: 'none',
  });
  el.textContent = label;
  return el;
}

const ARROW_SVG =
  '<svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true"><circle cx="15" cy="15" r="10" fill="var(--accent)" stroke="#fff" stroke-width="2.5"/><path d="M15 8.5 L19.5 18 L15 15.6 L10.5 18 Z" fill="#fff"/></svg>';

/** Nearest stream index to a map position (vertex search, then refined on the full-resolution samples). */
function nearestIndex(P: Prepared, g: RouteGeometry, lng: number, lat: number): number {
  const cos = Math.cos((lat * Math.PI) / 180);
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k < g.coords.length; k++) {
    const c = g.coords[k]!;
    const d = ((c[0] - lng) * cos) ** 2 + (c[1] - lat) ** 2;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  const a = g.idx[Math.max(0, best - 1)]!;
  const b = g.idx[Math.min(g.idx.length - 1, best + 1)]!;
  let bi = g.idx[best]!;
  bestD = Infinity;
  for (let i = a; i <= b; i++) {
    const d = ((P.lon![i]! - lng) * cos) ** 2 + (P.lat![i]! - lat) ** 2;
    if (d < bestD) {
      bestD = d;
      bi = i;
    }
  }
  return bi;
}

function LegendBox({ legend }: { legend: Legend }) {
  const { t } = useI18n();
  return (
    <div
      className="pointer-events-none absolute left-2 top-2 z-10 max-w-[70%] rounded-[10px] border border-border bg-surface/90 px-2.5 py-1.5 text-[11px] text-fg-2 shadow-card backdrop-blur"
      role="img"
      aria-label={t('activities.map.legend')}
    >
      {legend.kind === 'ramp' ? (
        <div className="flex items-center gap-2">
          <span className="text-right leading-tight">
            <span className="block font-medium text-fg">{legend.from}</span>
            {legend.fromLabel}
          </span>
          <span className="h-2 w-20 rounded-full" style={{ background: `linear-gradient(to right, ${legend.colors.join(',')})` }} />
          <span className="leading-tight">
            <span className="block font-medium text-fg">{legend.to}</span>
            {legend.toLabel}
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {legend.items.map((it) => (
            <span key={it.label} className="inline-flex items-center gap-1">
              <span className="h-2 w-3 rounded-sm" style={{ background: it.color }} />
              {it.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export interface ActivityMapProps {
  P: Prepared;
  geo: RouteGeometry;
  sport: string;
  playback: Playback;
  hover: Store<number | null>;
  selection: [number, number] | null;
  zoneBounds: number[];
  camera: CameraMode;
  onCamera: (c: CameraMode) => void;
  className?: string;
}

/**
 * Route map with replay: colored route (casing + line), start/finish and km/mi markers, a moving athlete marker,
 * the not-yet-travelled part dimmed, the selected section highlighted and three camera modes.
 * Map and charts share `hover` (index) and `playback.time`; everything per-frame is imperative.
 */
export function ActivityMap({ P, geo, sport, playback, hover, selection, zoneBounds, camera, onCamera, className }: ActivityMapProps) {
  const { t } = useI18n();
  const fmt = useFormat();
  const theme = useChartTheme();
  const resolved = useResolvedTheme();
  const [storedMode, setMode] = useStoredState<ColorMode>('activities.mapColor', 'pace');
  const modes = useMemo(() => availableModes(P), [P]);
  const mode: ColorMode = modes.includes(storedMode) ? storedMode : modes.includes('pace') ? 'pace' : 'plain';

  const coloring = useMemo(
    () =>
      routeColoring(mode, P, geo, theme, {
        sport,
        zoneBounds,
        fmt,
        labels: {
          slow: t('activities.map.slow'),
          fast: t('activities.map.fast'),
          low: t('activities.map.low'),
          high: t('activities.map.high'),
          downhill: t('activities.map.downhill'),
          uphill: t('activities.map.uphill'),
        },
        zoneLabels: [1, 2, 3, 4, 5].map((z) => `Z${z}`),
      }),
    [mode, P, geo, theme, sport, zoneBounds, fmt, t],
  );

  const chunks = useMemo(() => routeChunks(geo, coloring?.stops ?? null), [geo, coloring]);

  const kmPoints = useMemo(() => {
    if (!P.dist) return [];
    const unit = fmt.units === 'imperial' ? M_PER_MI : M_PER_KM;
    const count = Math.floor(P.totalDist / unit);
    const every = Math.max(1, Math.ceil(count / 40));
    const out: { pos: [number, number]; label: string }[] = [];
    for (let k = every; k <= count; k += every) {
      const pos = lngLatAt(P, indexAtDist(P, k * unit));
      if (pos) out.push({ pos, label: String(k) });
    }
    return out;
  }, [P, fmt.units]);

  /** Hover tooltip on the map: distance · time · pace/speed · heart rate at the hovered point. */
  const tipRef = useRef<HTMLDivElement>(null);
  const hoverText = (fi: number) => {
    const parts: string[] = [];
    if (P.dist) parts.push(fmt.distance(valueAt(P.dist, fi)));
    parts.push(clock(valueAt(P.t, fi)));
    if (P.speed && P.moving[Math.min(P.n - 1, Math.ceil(fi))]) parts.push(fmt.pace(valueAt(P.speed, fi), sport));
    const hr = valueAt(P.hr, fi);
    if (hr === hr) parts.push(fmt.hr(hr));
    return parts.join(' · ');
  };
  const hoverTextRef = useRef(hoverText);
  hoverTextRef.current = hoverText;
  const mapRef = useRef<Map | null>(null);
  const styleReady = useRef(false);
  const markers = useRef<{ athlete: Marker; hover: Marker; start: Marker; finish: Marker } | null>(null);
  const frame = useRef<number | null>(null);
  /** Index of the chunk being travelled (−1 = nothing drawn); −2 forces a redraw. */
  const lastChunk = useRef(-1);
  const lastHeadFi = useRef(-1);
  const dimmed = useRef(false);
  /** Plain route color of the current basemap (chunks without own color). */
  const plainColor = useRef('#e8590c');
  const dragging = useRef(false);
  /** True while one of our camera transitions runs (per-frame camera updates would cancel it). */
  const easing = useRef(false);
  const camBearing = useRef(0);
  const lastFrameAt = useRef(0);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const coloringRef = useRef(coloring);
  coloringRef.current = coloring;
  /** Track part shown by the overview camera (several parts: workout continued elsewhere). */
  const shownPart = useRef(0);
  const [activePart, setActivePart] = useState(0);
  const chunksRef = useRef(chunks);
  chunksRef.current = chunks;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const themeRef = useRef<{ resolved: ResolvedTheme; sel: string }>({ resolved, sel: theme.series[1]! });
  themeRef.current = { resolved, sel: theme.series[1]! };

  const render = useCallback(() => {
    frame.current = null;
    const map = mapRef.current;
    const m = markers.current;
    if (!map || !m) return;
    const time = playback.time.get();
    const st = playback.state.get();
    const fi = indexAtTime(P, time);
    const pos = lngLatAt(P, fi);
    if (!pos) return;
    m.athlete.setLngLat(pos).setRotation(headingAt(P, fi));
    // travelled part in full color on top of the dimmed route (once the replay started)
    const done = map.getSource(SRC.done) as GeoJSONSource | undefined;
    const head = map.getSource(SRC.head) as GeoJSONSource | undefined;
    if (done && head && styleReady.current) {
      const active = st.started && fi > 0.01;
      if (active !== dimmed.current) {
        dimmed.current = active;
        geo.parts.forEach((_, p) => {
          const id = routeId(p);
          if (map.getLayer(id)) map.setPaintProperty(id, 'line-opacity', active ? 0.35 : 1);
          if (map.getLayer(`${id}-casing`)) map.setPaintProperty(`${id}-casing`, 'line-opacity', active ? 0.5 : 1);
        });
      }
      const ch = chunksRef.current;
      if (active) {
        const k = Math.max(1, vertexAfter(geo, fi));
        const c = Math.min(ch.count - 1, Math.floor((k - 1) / ch.size));
        const color = (i: number) => ch.colors[i] ?? plainColor.current;
        if (c !== lastChunk.current) {
          const feats = [];
          for (let i = 0; i < c; i++)
            for (const line of coordsByPart(geo, i * ch.size, Math.min(geo.coords.length - 1, (i + 1) * ch.size)))
              feats.push(lineFeature(line, { color: color(i) }));
          done.setData(featureCollection(feats));
          lastChunk.current = c;
        }
        if (Math.abs(fi - lastHeadFi.current) > 0.01) {
          // the current part from the chunk start (or the part start) to the position; earlier parts of the chunk
          // are separate lines
          const part = geo.parts[partOfVertex(geo, k - 1)]!;
          const from = Math.max(c * ch.size, part.v0);
          const lines = coordsByPart(geo, c * ch.size, from - 1);
          lines.push([...geo.coords.slice(from, k), pos]);
          head.setData(featureCollection(lines.map((l) => lineFeature(l, { color: color(c) }))));
          lastHeadFi.current = fi;
        }
      } else if (lastChunk.current !== -1) {
        done.setData(featureCollection([]));
        head.setData(featureCollection([]));
        lastChunk.current = -1;
        lastHeadFi.current = -1;
      }
    }
    // camera
    const now = performance.now();
    const dt = Math.min(0.5, (now - (lastFrameAt.current || now)) / 1000);
    lastFrameAt.current = now;
    const cam = cameraRef.current;
    if (cam === 'overview' && geo.parts.length > 1 && !dragging.current && !easing.current) {
      // a workout in several parts (continued elsewhere): the overview shows the part being replayed
      const p = partOfVertex(geo, Math.max(0, vertexAfter(geo, fi) - 1));
      if (p !== shownPart.current) {
        shownPart.current = p;
        setActivePart(p);
        map.fitBounds(geo.parts[p]!.bounds as LngLatBoundsLike, { padding: FIT_PADDING, maxZoom: 16, duration: 800 });
      }
    }
    if (!dragging.current && !easing.current) {
      if (cam === 'follow') map.jumpTo({ center: pos });
      else if (cam === 'flyover') {
        camBearing.current = lerpAngle(camBearing.current, headingAt(P, fi, true), 1 - Math.exp(-dt / 1.2));
        map.jumpTo({ center: pos, bearing: camBearing.current });
      }
    }
    // hover marker
    const h = hover.get();
    const hp = h === null ? null : lngLatAt(P, h);
    const el = m.hover.getElement();
    const tip = tipRef.current;
    if (hp) {
      m.hover.setLngLat(hp);
      el.style.visibility = 'visible';
      if (tip) {
        const pt = map.project(hp);
        tip.textContent = hoverTextRef.current(h!);
        // keep the tooltip inside the map: centered above the point, clamped to the edges, below when no room
        const box = map.getContainer();
        const tw = tip.offsetWidth;
        const th = tip.offsetHeight;
        const x = Math.max(4, Math.min(box.clientWidth - tw - 4, pt.x - tw / 2));
        const y = pt.y - th - 12 >= 4 ? pt.y - th - 12 : pt.y + 12;
        tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
        tip.style.visibility = 'visible';
      }
    } else {
      el.style.visibility = 'hidden';
      if (tip) tip.style.visibility = 'hidden';
    }
  }, [P, geo, playback, hover]);

  const request = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(render);
  }, [render]);

  useEffect(() => {
    const a = playback.time.subscribe(request);
    const b = playback.state.subscribe(request);
    const c = hover.subscribe(request);
    return () => {
      a();
      b();
      c();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [playback, hover, request]);

  /** Route line (re)created with the current coloring, below the overlay layers. */
  const applyRoute = useCallback(
    (map: Map) => {
      const colors = overlayColors(currentPref(map), themeRef.current.resolved);
      const c = coloringRef.current;
      geo.parts.forEach((_, p) => {
        const id = routeId(p);
        for (const l of [id, `${id}-casing`]) if (map.getLayer(l)) map.removeLayer(l);
        addRouteLayers(map, id, {
          color: colors.route,
          casing: colors.casing,
          width: 4,
          gradient: c ? gradientExpression(partStops(geo, c.stops, p)) : undefined,
          beforeId: map.getLayer(`${SRC.done}-casing`) ? `${SRC.done}-casing` : undefined,
        });
      });
      plainColor.current = colors.route;
      dimmed.current = false;
      lastChunk.current = -2;
      lastHeadFi.current = -1;
    },
    [geo],
  );

  const applySelection = useCallback(
    (map: Map) => {
      const src = map.getSource(SRC.sel) as GeoJSONSource | undefined;
      if (!src) return;
      const s = selectionRef.current;
      if (!s || !P.lat || !P.lon) {
        src.setData(featureCollection([]));
        return;
      }
      const [a, b] = [Math.floor(Math.min(...s)), Math.ceil(Math.max(...s))];
      const step = Math.max(1, Math.ceil((b - a) / 2000));
      // one line per track part: never draw the jump between parts
      const lines: [number, number][][] = [];
      let cur: [number, number][] = [];
      let nb = 0;
      while (nb < P.breaks.length && P.breaks[nb]! <= a) nb++;
      const add = (i: number) => {
        while (nb < P.breaks.length && P.breaks[nb]! <= i) {
          if (cur.length > 1) lines.push(cur);
          cur = [];
          nb++;
        }
        cur.push([P.lon![i]!, P.lat![i]!]);
      };
      for (let i = a; i <= b; i += step) add(i);
      add(b);
      if (cur.length > 1) lines.push(cur);
      src.setData(featureCollection(lines.map((l) => lineFeature(l))));
    },
    [P],
  );

  const onStyleLoad = useCallback(
    (map: Map) => {
      const colors = overlayColors(currentPref(map), themeRef.current.resolved);
      geo.parts.forEach((p, i) => setGeoJSON(map, routeId(i), lineFeature(geo.coords.slice(p.v0, p.v1 + 1)), true));
      setGeoJSON(map, SRC.done, featureCollection([]));
      setGeoJSON(map, SRC.head, featureCollection([]));
      setGeoJSON(map, SRC.sel, featureCollection([]));
      // overlay layers first, then the route below them
      for (const src of [SRC.done, SRC.head]) {
        map.addLayer({
          id: `${src}-casing`,
          type: 'line',
          source: src,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': colors.casing, 'line-width': 7.5 },
        });
        map.addLayer({
          id: src,
          type: 'line',
          source: src,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-width': 4.5 },
        });
      }
      map.addLayer({
        id: `${SRC.sel}-casing`,
        type: 'line',
        source: SRC.sel,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': colors.darkBase ? '#000000' : '#ffffff', 'line-width': 10, 'line-opacity': 0.9 },
      });
      map.addLayer({
        id: SRC.sel,
        type: 'line',
        source: SRC.sel,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': themeRef.current.sel, 'line-width': 5.5 },
      });
      applyRoute(map);
      applySelection(map);
      styleReady.current = true;
      request();
    },
    [geo, applyRoute, applySelection, request],
  );

  const onReady = useCallback(
    (map: Map) => {
      mapRef.current = map;
      map.resize();
      map.fitBounds(geo.parts[0]!.bounds as LngLatBoundsLike, { padding: FIT_PADDING, maxZoom: 16, animate: false });
      const start = new Marker({
        element: markerEl({ ...DOT, background: 'var(--good)', display: 'grid', placeItems: 'center' }, START_HTML, t('activities.map.start')),
      })
        .setLngLat(geo.coords[0]!)
        .addTo(map);
      const finish = new Marker({
        element: markerEl(
          { ...DOT, background: 'repeating-conic-gradient(#111 0 25%, #fff 0 50%) 50% / 7px 7px' },
          '',
          t('activities.map.finish'),
        ),
      })
        .setLngLat(geo.coords[geo.coords.length - 1]!)
        .addTo(map);
      const hoverM = new Marker({
        element: markerEl({ ...DOT, width: '14px', height: '14px', background: 'var(--fg)', pointerEvents: 'none' }),
      })
        .setLngLat(geo.coords[0]!)
        .addTo(map);
      hoverM.getElement().style.visibility = 'hidden';
      const athlete = new Marker({
        element: markerEl({ width: '30px', height: '30px', pointerEvents: 'none', filter: 'drop-shadow(0 1px 3px rgba(0,0,0,.4))' }, ARROW_SVG, t('activities.playback.position')),
        rotationAlignment: 'map',
        pitchAlignment: 'map',
      })
        .setLngLat(geo.coords[0]!)
        .addTo(map);
      markers.current = { athlete, hover: hoverM, start, finish };

      let pending: MapMouseEvent | null = null;
      let raf: number | null = null;
      const pickAt = (e: MapMouseEvent): number | null => {
        const i = nearestIndex(P, geo, e.lngLat.lng, e.lngLat.lat);
        const p = map.project([P.lon![i]!, P.lat![i]!]);
        return Math.hypot(p.x - e.point.x, p.y - e.point.y) <= 24 ? i : null;
      };
      map.on('mousemove', (e) => {
        pending = e;
        if (raf === null)
          raf = requestAnimationFrame(() => {
            raf = null;
            if (!pending) return;
            const i = pickAt(pending);
            hover.set(i);
            map.getCanvas().style.cursor = i === null ? '' : 'pointer';
          });
      });
      map.on('mouseout', () => {
        pending = null;
        hover.set(null);
      });
      map.on('click', (e) => {
        const i = pickAt(e);
        if (i !== null) playback.seek(P.t[i]!);
      });
      map.on('dragstart', () => (dragging.current = true));
      map.on('dragend', () => (dragging.current = false));
      request();
    },
    [P, geo, hover, playback, request, t],
  );

  // km / mile markers (DOM: no glyphs needed, survive basemap switches)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const ms = kmPoints.map((k) => new Marker({ element: kmEl(k.label) }).setLngLat(k.pos).addTo(map));
    return () => ms.forEach((m) => m.remove());
  }, [kmPoints]);

  // coloring changed (mode, theme)
  useEffect(() => {
    const map = mapRef.current;
    if (map && styleReady.current && map.isStyleLoaded()) {
      applyRoute(map);
      request();
    }
  }, [coloring, applyRoute, request]);

  // selection changed: highlight + zoom to it in the overview
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady.current) return;
    applySelection(map);
    if (selection && cameraRef.current === 'overview' && P.lat && P.lon) {
      const [a, b] = [Math.floor(Math.min(...selection)), Math.ceil(Math.max(...selection))];
      let minLon = Infinity;
      let minLat = Infinity;
      let maxLon = -Infinity;
      let maxLat = -Infinity;
      for (let i = a; i <= b; i++) {
        minLon = Math.min(minLon, P.lon[i]!);
        maxLon = Math.max(maxLon, P.lon[i]!);
        minLat = Math.min(minLat, P.lat[i]!);
        maxLat = Math.max(maxLat, P.lat[i]!);
      }
      map.fitBounds([minLon, minLat, maxLon, maxLat] as LngLatBoundsLike, { padding: FIT_PADDING, maxZoom: 16, duration: 700 });
    }
  }, [selection, applySelection, P]);

  // camera transitions
  const firstCamera = useRef(true);
  useEffect(() => {
    if (firstCamera.current) {
      firstCamera.current = false;
      return;
    }
    const map = mapRef.current;
    if (!map) return;
    const fi = indexAtTime(P, playback.time.get());
    const pos = lngLatAt(P, fi);
    easing.current = true;
    map.once('moveend', () => {
      easing.current = false;
      request();
    });
    if (camera === 'overview') {
      const part = geo.parts.length > 1 ? geo.parts[partOfVertex(geo, Math.max(0, vertexAfter(geo, fi) - 1))]! : null;
      shownPart.current = part ? geo.parts.indexOf(part) : 0;
      map.fitBounds((part?.bounds ?? geo.bounds) as LngLatBoundsLike, {
        padding: FIT_PADDING,
        pitch: 0,
        bearing: 0,
        maxZoom: 16,
        duration: 900,
      });
    } else if (camera === 'follow' && pos) {
      map.easeTo({ center: pos, zoom: Math.max(map.getZoom(), 15), pitch: 0, bearing: 0, duration: 900 });
    } else if (camera === 'flyover' && pos) {
      camBearing.current = headingAt(P, fi, true);
      map.easeTo({ center: pos, zoom: 15.6, pitch: 62, bearing: camBearing.current, duration: 1600 });
    }
  }, [camera, P, geo, playback, request]);

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Palette size={15} className="shrink-0 text-fg-3" aria-hidden />
          <SegmentedControl
            size="sm"
            label={t('activities.map.colorBy')}
            value={mode}
            onChange={setMode}
            items={modes.map((m) => ({ value: m, label: t(`activities.map.modes.${m === 'pace' && !isPaceSport(sport) ? 'speed' : m}`) }))}
          />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <Camera size={15} className="shrink-0 text-fg-3" aria-hidden />
          <SegmentedControl
            size="sm"
            label={t('activities.map.camera')}
            value={camera}
            onChange={onCamera}
            items={(['overview', 'follow', 'flyover'] as const).map((c) => ({ value: c, label: t(`activities.map.cameras.${c}`) }))}
          />
        </div>
      </div>
      {geo.parts.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label={t('activities.map.parts.label')}>
          <Split size={15} className="shrink-0 text-fg-3" aria-hidden />
          {geo.parts.map((p, i) => {
            const from = geo.idx[p.v0]!;
            const to = geo.idx[p.v1]!;
            const km = P.dist ? P.dist[to]! - P.dist[from]! : null;
            return (
              <button
                key={i}
                type="button"
                aria-pressed={activePart === i}
                onClick={() => {
                  // jump the replay to the part's start; the overview camera then shows that part
                  setActivePart(i);
                  if (cameraRef.current !== 'overview') onCamera('overview');
                  playback.seek(P.t[from]!);
                  const map = mapRef.current;
                  if (map) {
                    shownPart.current = i;
                    map.fitBounds(p.bounds as LngLatBoundsLike, { padding: FIT_PADDING, maxZoom: 16, duration: 800 });
                  }
                }}
                className={cn(
                  'rounded-full border px-2.5 py-1 font-medium transition-colors',
                  activePart === i ? 'border-accent bg-accent-soft text-accent-fg' : 'border-border text-fg-2 hover:bg-surface-2',
                )}
              >
                {t('activities.map.parts.part', { n: i + 1 })}
                {km !== null && <span className="ml-1 font-normal text-fg-3">{fmt.distance(km)}</span>}
              </button>
            );
          })}
          <span className="text-fg-3">{t('activities.map.parts.hint')}</span>
        </div>
      )}
      <BaseMap
        className="h-[min(62vh,520px)] min-h-72"
        bounds={geo.parts[0]!.bounds}
        terrain={camera === 'flyover'}
        onReady={onReady}
        onStyleLoad={onStyleLoad}
      >
        {coloring && <LegendBox legend={coloring.legend} />}
        <div
          ref={tipRef}
          aria-hidden
          className="pointer-events-none invisible absolute left-0 top-0 z-10 whitespace-nowrap rounded-lg border border-border bg-surface px-2 py-1 text-xs font-medium tabular text-fg shadow-pop"
        />
      </BaseMap>
    </div>
  );
}
