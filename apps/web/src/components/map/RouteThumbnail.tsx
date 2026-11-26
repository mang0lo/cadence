import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { cn } from '@/components/ui';
import { useSettings } from '@/lib/settings';
import { useResolvedTheme } from '@/lib/theme';
import { holdSnapshot, peekSnapshot, snapshotKey, type SnapshotRequest } from './snapshot';
import {
  TILE_ATTRIBUTION as ATTRIBUTION,
  TILE_ATTRIBUTION_SHORT,
  isRasterBasemap,
  thumbnailBasemap,
  thumbnailLayout,
  tileUrl,
} from './tiles';

export { thumbnailBasemap, thumbnailLayout, tileUrl, type ThumbnailBasemap, type ThumbnailLayout } from './tiles';

const devicePixelRatioOf = () => (typeof window !== 'undefined' && window.devicePixelRatio >= 1.5 ? 2 : 1);

/**
 * Object URL of the snapshot for a request (null while it renders or when it cannot be rendered). The image is held
 * while it is shown: a render that is still queued when the request changes or the preview unmounts is skipped.
 */
function useSnapshot(req: SnapshotRequest | null): string | null {
  const key = req ? snapshotKey(req) : null;
  // renders again once the image is ready; the URL itself is read from the store (also before the effect has run, so
  // an image that is already in this page shows at once)
  const [, ready] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!req || !key) return;
    const held = holdSnapshot(req);
    let live = true;
    void held.promise.then(() => live && ready());
    return () => {
      live = false;
      held.release();
    };
    // the key identifies the request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return key ? peekSnapshot(key) : null;
}

/** A new size is used once the layout has rested this long (a resize drag passes through every width). */
const SETTLE_MS = 200;

/**
 * Rendered size of the element (CSS px, rounded) and whether it is near the viewport. Thumbnails away from the
 * viewport load no tiles and no map image; the layout is computed for the real size so the map fills the box
 * whatever its aspect ratio. The first size is taken at once, later changes once they have settled.
 */
function useBox<T extends Element>(): [React.RefObject<T | null>, { w: number; h: number } | null, boolean] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let measured = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (w > 0 && h > 0) {
        measured = true;
        setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
      }
    };
    measure();
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            clearTimeout(timer);
            if (!measured) measure();
            else timer = setTimeout(measure, SETTLE_MS);
          })
        : null;
    ro?.observe(el);
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'undefined') setNear(true);
    else {
      io = new IntersectionObserver(
        (entries) => {
          const last = entries[entries.length - 1];
          if (last) setNear(last.isIntersecting);
        },
        { rootMargin: '300px' },
      );
      io.observe(el);
    }
    return () => {
      clearTimeout(timer);
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
  const wantMap = basemap && settings.thumbnailMaps !== false && near && !!box && !!layout;
  const raster = isRasterBasemap(base);
  // vector basemaps: one rendered image of exactly this view box
  const snapReq = useMemo<SnapshotRequest | null>(
    () =>
      wantMap && !raster && base !== 'satellite' && layout
        ? { base, width: w, height: h, pixelRatio: devicePixelRatioOf(), view: layout.view }
        : null,
    [wantMap, raster, base, w, h, layout],
  );
  const snapshot = useSnapshot(snapReq);
  const showTiles = wantMap && (raster ? !!layout?.tiles.length : !!snapshot);

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${w} ${h}`}
      className={cn('block overflow-hidden rounded-control bg-surface-2', className)}
      role="img"
      aria-label={ariaLabel}
      preserveAspectRatio="xMidYMid meet"
    >
      {showTiles && !raster && (
        <g aria-hidden>
          <title>{ATTRIBUTION[base]}</title>
          <image href={snapshot!} x={0} y={0} width={w} height={h} preserveAspectRatio="none" />
        </g>
      )}
      {showTiles && raster && (
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
          {TILE_ATTRIBUTION_SHORT[base]}
        </text>
      )}
    </svg>
  );
}
