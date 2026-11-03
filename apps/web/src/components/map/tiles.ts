/**
 * Raster map tiles behind route previews: Web Mercator fitting of a route into a box and the tiles that cover it.
 * Pure (no DOM, no app imports) — used by the SVG route thumbnails and the canvas share image.
 */
import type { MapStylePref } from '@cadence/shared';
import { decodePolylineParts } from '../../lib/polyline';

/** Web Mercator projection (unit square). */
export function project(lat: number, lon: number): [number, number] {
  const x = (lon + 180) / 360;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return [x, y];
}

export type ThumbnailBasemap = 'light' | 'dark' | 'voyager' | 'satellite';

/** Raster basemap for the user's map style (raster tiles: no WebGL, hundreds can render at once). */
export function thumbnailBasemap(pref: MapStylePref, theme: 'light' | 'dark'): ThumbnailBasemap {
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

/** Attribution the tile providers require wherever their tiles are shown. */
export const TILE_ATTRIBUTION: Record<ThumbnailBasemap, string> = {
  light: '© OpenStreetMap contributors © CARTO',
  dark: '© OpenStreetMap contributors © CARTO',
  voyager: '© OpenStreetMap contributors © CARTO',
  satellite: 'Imagery © Esri, Maxar, Earthstar Geographics',
};

/** Pixel size of the tile images (CARTO is fetched @2x, Esri imagery is 256 px). */
export const TILE_IMAGE_PX: Record<ThumbnailBasemap, number> = { light: 512, dark: 512, voyager: 512, satellite: 256 };

export interface FitPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FitTile {
  z: number;
  x: number;
  y: number;
  left: number;
  top: number;
  size: number;
}

export interface TrackFit {
  /** The parts in view-box coordinates (a part never connects to the next one). */
  parts: [number, number][][];
  start: readonly [number, number];
  end: readonly [number, number];
  /** Tiles covering the whole view box, positioned in view-box units. */
  tiles: FitTile[];
}

const MAX_Z = 18;

/**
 * Fit the parts of a track ([lat, lon] points) into a width × height view box, inside the padding, and list the map
 * tiles behind the whole box. The tile zoom is the next integer above the fitted (fractional) zoom plus `zoomBias`,
 * so tiles are shown at 50–100 % of their size (× 2^-zoomBias) and stay sharp.
 */
export function fitTracks(
  track: [number, number][][],
  width: number,
  height: number,
  pad: number | FitPadding = 8,
  zoomBias = 0,
): TrackFit | null {
  const p: FitPadding = typeof pad === 'number' ? { top: pad, right: pad, bottom: pad, left: pad } : pad;
  const parts = track.map((part) => part.map(([la, lo]) => project(la, lo))).filter((part) => part.length >= 2);
  if (!parts.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const part of parts)
    for (const [x, y] of part) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  const fit = Math.min(
    (width - p.left - p.right) / (maxX - minX || 1e-12),
    (height - p.top - p.bottom) / (maxY - minY || 1e-12),
  );
  // a 1 km route must not zoom in beyond the tiles' detail: at zoom z the world is 256 · 2^z view-box units wide
  const scale = Math.min(fit, 256 * 2 ** MAX_Z);
  const ox = (p.left + width - p.right - (maxX - minX) * scale) / 2;
  const oy = (p.top + height - p.bottom - (maxY - minY) * scale) / 2;
  const px = (x: number) => ox + (x - minX) * scale;
  const py = (y: number) => oy + (y - minY) * scale;
  const out = parts.map((part) => part.map(([x, y]) => [px(x), py(y)] as [number, number]));
  const first = out[0]![0]!;
  const lastPart = out[out.length - 1]!;
  const last = lastPart[lastPart.length - 1]!;

  const z = Math.max(0, Math.min(MAX_Z, Math.ceil(Math.log2(scale / 256) - 1e-9) + zoomBias));
  const n = 2 ** z;
  const size = scale / n;
  // world (unit square) coordinates of the view box corners
  const ux = (vx: number) => minX + (vx - ox) / scale;
  const uy = (vy: number) => minY + (vy - oy) / scale;
  const tiles: FitTile[] = [];
  const x0 = Math.floor(ux(0) * n);
  const x1 = Math.floor(ux(width) * n);
  const y0 = Math.max(0, Math.floor(uy(0) * n));
  const y1 = Math.min(n - 1, Math.floor(uy(height) * n));
  if (x1 - x0 <= 16 && y1 - y0 <= 16)
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++)
        tiles.push({ z, x: ((tx % n) + n) % n, y: ty, left: px(tx / n), top: py(ty / n), size });
  return { parts: out, start: first, end: last, tiles };
}

export interface ThumbnailLayout {
  /** SVG path of all parts (a part never connects to the next one). */
  d: string;
  start: readonly [number, number];
  end: readonly [number, number];
  /** Tiles covering the view box, positioned in view-box units. */
  tiles: FitTile[];
}

/** `fitTracks` for an encoded (possibly multi-part) polyline, with the route as one SVG path. */
export function thumbnailLayout(polyline: string, width: number, height: number, pad = 8): ThumbnailLayout | null {
  const fit = fitTracks(decodePolylineParts(polyline), width, height, pad);
  if (!fit) return null;
  const d = fit.parts
    .map((part) => part.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(''))
    .join('');
  return { d, start: fit.start, end: fit.end, tiles: fit.tiles };
}
