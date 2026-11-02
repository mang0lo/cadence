import { useEffect, useMemo, useRef, useState } from 'react';
import type { MapStylePref } from '@cadence/shared';
import { cn } from '@/components/ui';
import { decodePolylineParts } from '@/lib/polyline';
import { useSettings } from '@/lib/settings';
import { useResolvedTheme, type ResolvedTheme } from '@/lib/theme';

/** Web Mercator projection (unit square). */
function project(lat: number, lon: number): [number, number] {
  const x = (lon + 180) / 360;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return [x, y];
}

export type ThumbnailBasemap = 'light' | 'dark' | 'voyager' | 'satellite';

/** Raster basemap of a thumbnail for the user's map style (raster tiles: no WebGL, hundreds can render at once). */
export function thumbnailBasemap(pref: MapStylePref, theme: ResolvedTheme): ThumbnailBasemap {
  switch (pref) {
    case 'satellite':
      return 'satellite';
    case 'outdoor':
      return 'voyager';
    case 'dark':
      return 'dark';
    default:
      return theme === 'dark' ? 'dark' : 'light';
  }
}

/** URL of one raster tile (CARTO basemaps in 2× resolution, Esri World Imagery for satellite). */
export function tileUrl(base: ThumbnailBasemap, z: number, x: number, y: number): string {
  if (base === 'satellite')
    return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  const path = base === 'voyager' ? 'rastertiles/voyager' : base === 'dark' ? 'dark_all' : 'light_all';
  return `https://${'abcd'[(x + y) % 4]}.basemaps.cartocdn.com/${path}/${z}/${x}/${y}@2x.png`;
}

const ATTRIBUTION: Record<ThumbnailBasemap, string> = {
  light: '© OpenStreetMap contributors © CARTO',
  dark: '© OpenStreetMap contributors © CARTO',
  voyager: '© OpenStreetMap contributors © CARTO',
  satellite: 'Imagery © Esri, Maxar, Earthstar Geographics',
};

export interface ThumbnailLayout {
  /** SVG path of all parts (a part never connects to the next one). */
  d: string;
  start: readonly [number, number];
  end: readonly [number, number];
  /** Tiles covering the view box, positioned in view-box units. */
  tiles: { z: number; x: number; y: number; left: number; top: number; size: number }[];
}

/**
 * Fit the route into a width × height view box (with padding) and list the map tiles behind it. The tile zoom is the
 * next integer above the fitted (fractional) zoom, so tiles are shown at 50–100 % of their size and stay sharp.
 */
export function thumbnailLayout(polyline: string, width: number, height: number, pad = 8): ThumbnailLayout | null {
  const parts = decodePolylineParts(polyline)
    .map((p) => p.map(([la, lo]) => project(la, lo)))
    .filter((p) => p.length >= 2);
  if (!parts.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of parts)
    for (const [x, y] of p) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  const MAX_Z = 18;
  const fit = Math.min((width - 2 * pad) / (maxX - minX || 1e-12), (height - 2 * pad) / (maxY - minY || 1e-12));
  // a 1 km route must not zoom in beyond the tiles' detail: at zoom z the world is 256 · 2^z view-box units wide
  const scale = Math.min(fit, 256 * 2 ** MAX_Z);
  const ox = (width - (maxX - minX) * scale) / 2;
  const oy = (height - (maxY - minY) * scale) / 2;
  const px = (x: number) => ox + (x - minX) * scale;
  const py = (y: number) => oy + (y - minY) * scale;
  const d = parts
    .map((p) => p.map(([x, y], i) => `${i ? 'L' : 'M'}${px(x).toFixed(1)},${py(y).toFixed(1)}`).join(''))
    .join('');
  const first = parts[0]![0]!;
  const lastPart = parts[parts.length - 1]!;
  const last = lastPart[lastPart.length - 1]!;

  const z = Math.max(0, Math.min(MAX_Z, Math.ceil(Math.log2(scale / 256) - 1e-9)));
  const n = 2 ** z;
  const size = scale / n;
  // world (unit square) coordinates of the view box corners
  const ux = (vx: number) => minX + (vx - ox) / scale;
  const uy = (vy: number) => minY + (vy - oy) / scale;
  const tiles: ThumbnailLayout['tiles'] = [];
  const x0 = Math.floor(ux(0) * n);
  const x1 = Math.floor(ux(width) * n);
  const y0 = Math.max(0, Math.floor(uy(0) * n));
  const y1 = Math.min(n - 1, Math.floor(uy(height) * n));
  if (x1 - x0 <= 16 && y1 - y0 <= 16)
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++)
        tiles.push({
          z,
          x: ((tx % n) + n) % n,
          y: ty,
          left: px(tx / n),
          top: py(ty / n),
          size,
        });
  return { d, start: [px(first[0]), py(first[1])], end: [px(last[0]), py(last[1])], tiles };
}

/**
 * Rendered size of the element (CSS px, rounded) and whether it came near the viewport. Off-screen thumbnails load no
 * tiles; the layout is computed for the real size so the map fills the box whatever its aspect ratio.
 */
function useBox<T extends Element>(): [React.RefObject<T | null>, { w: number; h: number } | null, boolean] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (w > 0 && h > 0) setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'undefined') setNear(true);
    else {
      io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            setNear(true);
            io?.disconnect();
          }
        },
        { rootMargin: '300px' },
      );
      io.observe(el);
    }
    return () => {
      ro?.disconnect();
      io?.disconnect();
    };
  }, []);
  return [ref, size, near];
}

/**
 * Route preview for feeds and lists: the route over a small raster map (no WebGL, hundreds can render at once, unlike
 * the interactive maps). Tiles load when the preview comes near the viewport and are cached by the browser; without
 * network the route is shown on the plain background. Parts of a route (paused and continued elsewhere) are drawn
 * separately.
 */
export function RouteThumbnail({
  polyline,
  className,
  color = 'var(--accent)',
  width = 160,
  height = 100,
  strokeWidth = 2.5,
  ariaLabel,
  basemap = true,
}: {
  polyline: string | null | undefined;
  className?: string;
  color?: string;
  width?: number;
  height?: number;
  strokeWidth?: number;
  ariaLabel?: string;
  /** Show map tiles behind the route (default true; the user can turn them off for all previews in the settings). */
  basemap?: boolean;
}) {
  const { settings } = useSettings();
  const theme = useResolvedTheme();
  const base = thumbnailBasemap(settings.mapStyle, theme);
  const [ref, box, near] = useBox<SVGSVGElement>();
  // the props give the aspect ratio for `h-auto` boxes; once measured, the view box is the real size in CSS px
  const w = box?.w ?? width;
  const h = box?.h ?? height;
  const layout = useMemo(() => (polyline ? thumbnailLayout(polyline, w, h) : null), [polyline, w, h]);
  const darkBase = base === 'dark' || base === 'satellite';
  const casing = darkBase ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.95)';
  const showTiles = basemap && settings.thumbnailMaps !== false && near && !!box && !!layout?.tiles.length;

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${w} ${h}`}
      className={cn('block overflow-hidden rounded-control bg-surface-2', className)}
      role="img"
      aria-label={ariaLabel}
      preserveAspectRatio="xMidYMid meet"
    >
      {showTiles && (
        <g aria-hidden>
          <title>{ATTRIBUTION[base]}</title>
          {layout!.tiles.map((tl) => (
            <image
              key={`${tl.z}/${tl.x}/${tl.y}/${tl.left}`}
              href={tileUrl(base, tl.z, tl.x, tl.y)}
              x={tl.left}
              y={tl.top}
              // a hair larger: no seams between neighbouring tiles at fractional scales
              width={tl.size + 0.5}
              height={tl.size + 0.5}
              preserveAspectRatio="none"
            />
          ))}
        </g>
      )}
      {layout && (
        <>
          <path d={layout.d} fill="none" stroke={showTiles ? casing : 'var(--surface)'} strokeWidth={strokeWidth + 2.5} strokeLinecap="round" strokeLinejoin="round" />
          <path d={layout.d} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
          <circle cx={layout.end[0]} cy={layout.end[1]} r={3.5} fill="var(--fg)" stroke="var(--surface)" strokeWidth={1.5} />
          <circle cx={layout.start[0]} cy={layout.start[1]} r={3.5} fill="var(--good)" stroke="var(--surface)" strokeWidth={1.5} />
        </>
      )}
      {showTiles && w >= 300 && (
        <text
          x={w - 4}
          y={h - 4}
          textAnchor="end"
          fontSize={9}
          fill={darkBase ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)'}
          aria-hidden
        >
          {base === 'satellite' ? '© Esri' : '© OSM · CARTO'}
        </text>
      )}
    </svg>
  );
}
