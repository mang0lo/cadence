/**
 * Draws the share image of an activity on a canvas: map tiles (CORS-clean, else the plain background), the route in
 * the sport color with a white casing, start/finish, title, date, place, key stats, the wordmark and the map
 * attribution. Layout, privacy cut and colors come from share.ts.
 */
import { mapSnapshot } from '@/components/map/snapshot';
import {
  TILE_ATTRIBUTION,
  TILE_IMAGE_PX,
  fitTracks,
  isRasterBasemap,
  tileUrl,
  type ThumbnailBasemap,
} from '@/components/map/tiles';
import {
  MAX_SHARE_TILES,
  SHARE_PALETTE,
  shareLayout,
  type ChartSeries,
  type LatLon,
  type Rect,
  type ShareBackground,
  type ShareFormat,
  type SharePalette,
  type ShareTheme,
} from './share';
import { LruMap } from './lru';

export interface ShareStat {
  label: string;
  value: string;
  unit?: string;
}

/** A mini chart below the route: label ("Elevation"), a value ("↗ 420 m") and the normalized line. */
export interface ShareChart {
  label: string;
  value: string;
  series: ChartSeries;
  /** 'sport' = the sport color; else a palette color name. */
  color: 'sport' | 'hr' | 'power' | 'elevation';
}

export interface ShareContent {
  title: string;
  /** Date, time and place. */
  subtitle: string;
  sportLabel: string;
  /** Sport color slot 1..8, 0 = other (lib/sports.tsx). */
  sportSlot: number;
  /** The sport icon as rendered in the DOM (lucide SVG); drawn as vector paths. */
  icon: SVGSVGElement | null;
  stats: ShareStat[];
  /** Mini charts (at most three are drawn). */
  charts?: ShareChart[];
  /** The route ([lat, lon] parts, already without privacy zones); empty = no route. */
  parts: LatLon[][];
  showStart: boolean;
  showEnd: boolean;
  /** With the route line hidden: the route's extent for the map background (never drawn). */
  area?: LatLon[][];
  /** "Cadence" */
  brand: string;
}

export interface ShareOptions {
  format: ShareFormat;
  background: ShareBackground;
  theme: ShareTheme;
  basemap: ThumbnailBasemap;
}

export interface ShareResult {
  canvas: HTMLCanvasElement;
  /** Map tiles are on the image (with their attribution). */
  map: boolean;
  /** The map was asked for but could not be used (a tile failed or would taint the canvas). */
  mapFailed: boolean;
}

const FONT = '"Inter Variable", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const font = (weight: number, size: number) => `${weight} ${Math.round(size)}px ${FONT}`;

/**
 * Recently used map tiles: every tile of one image (up to 160 for a story, see MAX_SHARE_TILES), so re-rendering a
 * preview reuses all of them, but a long session does not keep every tile it ever drew.
 */
const tiles = new LruMap<string, Promise<HTMLImageElement>>(MAX_SHARE_TILES);

/** An image as a CORS-clean element (rejects on an error or after `timeoutMs`). */
function loadImage(url: string, timeoutMs: number): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = window.setTimeout(() => reject(new Error('image timeout')), timeoutMs);
    img.onload = () => {
      window.clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('image failed'));
    };
    img.src = url;
  });
}

/** A map tile (cached; a failed tile is retried next time). */
function loadTile(url: string): Promise<HTMLImageElement> {
  let p = tiles.get(url);
  if (!p) {
    const loading = loadImage(url, 10_000);
    loading.catch(() => tiles.deleteIf(url, loading));
    tiles.set(url, (p = loading));
  }
  return p;
}

async function loadFonts(): Promise<void> {
  if (!document.fonts?.load) return;
  await Promise.all([400, 500, 600, 700].map((w) => document.fonts.load(font(w, 40)).catch(() => undefined)));
}

/** The longest prefix of `text` (plus "…") that fits into `max` px. */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid).trimEnd()}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

/** Word-wrapped lines (at most `maxLines`; the last one takes the rest and is ellipsized). */
function wrap(ctx: CanvasRenderingContext2D, text: string, max: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i]!;
    if (!cur || ctx.measureText(next).width <= max) {
      cur = next;
      continue;
    }
    if (lines.length === maxLines - 1) {
      cur = [cur, ...words.slice(i)].join(' ');
      break;
    }
    lines.push(cur);
    cur = words[i]!;
  }
  if (cur) lines.push(cur);
  return lines.map((l) => ellipsize(ctx, l, max));
}

/** Font size ≤ `size` at which `text` fits into `max` px (down to 60 %). */
function fitSize(ctx: CanvasRenderingContext2D, text: string, weight: number, size: number, max: number): number {
  let s = size;
  ctx.font = font(weight, s);
  while (s > size * 0.6 && ctx.measureText(text).width > max) {
    s -= 2;
    ctx.font = font(weight, s);
  }
  return s;
}

/** A lucide icon (24 × 24 stroke icon) drawn from its SVG elements as canvas paths. */
function drawIcon(ctx: CanvasRenderingContext2D, svg: SVGSVGElement, x: number, y: number, size: number, color: string) {
  const vb = svg.viewBox?.baseVal;
  const k = size / (vb && vb.width ? vb.width : 24);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Number(svg.getAttribute('stroke-width') ?? 2) || 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const el of Array.from(svg.querySelectorAll('path, circle, ellipse, line, rect, polyline, polygon'))) {
    const n = (a: string) => Number(el.getAttribute(a) ?? 0) || 0;
    const tag = el.tagName.toLowerCase();
    let p: Path2D;
    if (tag === 'path') p = new Path2D(el.getAttribute('d') ?? '');
    else {
      p = new Path2D();
      if (tag === 'circle') p.arc(n('cx'), n('cy'), n('r'), 0, Math.PI * 2);
      else if (tag === 'ellipse') p.ellipse(n('cx'), n('cy'), n('rx'), n('ry'), 0, 0, Math.PI * 2);
      else if (tag === 'line') {
        p.moveTo(n('x1'), n('y1'));
        p.lineTo(n('x2'), n('y2'));
      } else if (tag === 'rect') p.roundRect(n('x'), n('y'), n('width'), n('height'), n('rx'));
      else {
        const pts = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number);
        for (let i = 0; i + 1 < pts.length; i += 2) {
          if (i) p.lineTo(pts[i]!, pts[i + 1]!);
          else p.moveTo(pts[i]!, pts[i + 1]!);
        }
        if (tag === 'polygon') p.closePath();
      }
    }
    const fill = el.getAttribute('fill');
    if (fill && fill !== 'none') ctx.fill(p);
    ctx.stroke(p);
  }
  ctx.restore();
}

/** The Cadence mark (components/layout/Logo.tsx): a rising route line on the brand color. */
function drawLogo(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
  const k = size / 64;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(0, 0, 64, 64, 15);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(new Path2D('M14 41 L24 25 L32 35 L40 19 L50 41'));
  ctx.restore();
}

/** A band from y0 to y1 in the scrim color; `stops` are [position 0..1 within the band, alpha]. */
function scrim(ctx: CanvasRenderingContext2D, pal: SharePalette, y0: number, y1: number, stops: [number, number][]) {
  const [r, g, b] = pal.scrim;
  const grad = ctx.createLinearGradient(0, y0, 0, y1);
  for (const [at, alpha] of stops) grad.addColorStop(Math.max(0, Math.min(1, at)), `rgba(${r},${g},${b},${alpha})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, y0, ctx.canvas.width, y1 - y0);
}

function drawHeader(ctx: CanvasRenderingContext2D, c: ShareContent, r: Rect, f: ReturnType<typeof shareLayout>['font'], pal: SharePalette, sport: string) {
  let y = r.y;
  // sport: icon on the sport color, label
  const chip = Math.round(f.sport * 1.45);
  ctx.fillStyle = sport;
  ctx.beginPath();
  ctx.arc(r.x + chip / 2, y + chip / 2, chip / 2, 0, Math.PI * 2);
  ctx.fill();
  if (c.icon) drawIcon(ctx, c.icon, r.x + chip * 0.22, y + chip * 0.22, chip * 0.56, '#ffffff');
  ctx.font = font(600, f.sport);
  ctx.fillStyle = pal.fg2;
  ctx.textBaseline = 'middle';
  ctx.fillText(ellipsize(ctx, c.sportLabel, r.w - chip - 16), r.x + chip + 14, y + chip / 2 + 1);
  y += chip + 18;
  // title: up to two lines
  ctx.font = font(700, f.title);
  ctx.fillStyle = pal.fg;
  ctx.textBaseline = 'top';
  const lines = wrap(ctx, c.title, r.w, 2);
  for (const line of lines) {
    ctx.fillText(line, r.x, y);
    y += f.title * 1.16;
  }
  y += 12;
  ctx.font = font(400, f.subtitle);
  ctx.fillStyle = pal.fg2;
  ctx.fillText(ellipsize(ctx, c.subtitle, r.w), r.x, y);
}

function drawStats(ctx: CanvasRenderingContext2D, c: ShareContent, l: ReturnType<typeof shareLayout>, pal: SharePalette) {
  const f = l.font;
  const colW = l.stats.w / l.cols;
  const rowH = (l.stats.h - (l.rows - 1) * 36) / l.rows;
  ctx.textBaseline = 'top';
  c.stats.slice(0, l.cols * l.rows).forEach((s, i) => {
    const x = l.stats.x + (i % l.cols) * colW;
    const y = l.stats.y + Math.floor(i / l.cols) * (rowH + 36);
    const max = colW - 20;
    ctx.textBaseline = 'top';
    ctx.font = font(500, f.label);
    ctx.fillStyle = pal.fg3;
    ctx.fillText(ellipsize(ctx, s.label, max), x, y);
    // value and unit share one baseline; both shrink when they do not fit the column
    ctx.font = font(500, f.unit);
    const unitW = s.unit ? ctx.measureText(` ${s.unit}`).width : 0;
    const size = fitSize(ctx, s.value, 700, f.value, max - unitW);
    const baseline = y + f.label * 1.3 + 8 + f.value * 0.95;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = pal.fg;
    ctx.fillText(s.value, x, baseline);
    if (s.unit) {
      const vw = ctx.measureText(s.value).width;
      ctx.font = font(500, f.unit * Math.max(0.75, size / f.value));
      ctx.fillStyle = pal.fg2;
      ctx.fillText(` ${s.unit}`, x + vw, baseline);
    }
  });
}

function chartColor(c: ShareChart, pal: SharePalette, sport: string): string {
  switch (c.color) {
    case 'hr':
      return pal.series[7]!;
    case 'power':
      return pal.series[6]!;
    case 'elevation':
      return pal.fg3;
    default:
      return sport;
  }
}

/** Mini charts side by side: label and value above a filled line (no axes: the shape is the point). */
function drawCharts(
  ctx: CanvasRenderingContext2D,
  charts: ShareChart[],
  r: Rect,
  f: ReturnType<typeof shareLayout>['font'],
  pal: SharePalette,
  sport: string,
) {
  const gap = 32;
  const n = charts.length;
  const w = (r.w - gap * (n - 1)) / n;
  const labelSize = Math.round(f.label * 0.9);
  const head = Math.round(labelSize * 1.5);
  charts.forEach((c, i) => {
    const x = r.x + i * (w + gap);
    const color = chartColor(c, pal, sport);
    ctx.textBaseline = 'top';
    ctx.font = font(500, labelSize);
    ctx.fillStyle = pal.fg3;
    const valueW = (() => {
      ctx.font = font(600, labelSize);
      return ctx.measureText(c.value).width;
    })();
    ctx.font = font(500, labelSize);
    ctx.fillText(ellipsize(ctx, c.label, Math.max(40, w - valueW - 12)), x, r.y);
    ctx.font = font(600, labelSize);
    ctx.fillStyle = pal.fg2;
    ctx.textAlign = 'right';
    ctx.fillText(c.value, x + w, r.y);
    ctx.textAlign = 'left';
    // plot area
    const top = r.y + head;
    const h = r.h - head;
    const px = (v: number) => x + v * w;
    const py = (v: number) => top + (1 - v) * (h - 4) + 2;
    // a hairline at the bottom
    ctx.fillStyle = pal.fg3;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x, top + h - 1, w, 1.5);
    ctx.globalAlpha = 1;
    for (const part of c.series.parts) {
      const line = new Path2D();
      part.forEach(([vx, vy], j) => (j ? line.lineTo(px(vx), py(vy)) : line.moveTo(px(vx), py(vy))));
      const area = new Path2D(line);
      area.lineTo(px(part[part.length - 1]![0]), top + h);
      area.lineTo(px(part[0]![0]), top + h);
      area.closePath();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.18;
      ctx.fill(area);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke(line);
    }
  });
}

function drawRoute(ctx: CanvasRenderingContext2D, parts: [number, number][][], color: string, w: number) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const path = new Path2D();
  // every part is its own line: never a stroke across a track break
  for (const part of parts) part.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = w + 7;
  ctx.stroke(path);
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.stroke(path);
}

function drawStart(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = r * 0.36;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - r * 0.3, y - r * 0.45);
  ctx.lineTo(x + r * 0.5, y);
  ctx.lineTo(x - r * 0.3, y + r * 0.45);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

function drawFinish(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();
  const s = r / 2;
  for (let i = -2; i < 2; i++)
    for (let j = -2; j < 2; j++) {
      ctx.fillStyle = (i + j) % 2 === 0 ? '#111111' : '#ffffff';
      ctx.fillRect(x + i * s, y + j * s, s, s);
    }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.lineWidth = r * 0.36;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
}

/** Draw the image into a new canvas. Never rejects because of the map: without tiles it uses the plain background. */
export async function renderShareImage(c: ShareContent, o: ShareOptions): Promise<ShareResult> {
  const routeless = !c.parts.some((p) => p.length >= 2);
  const charts = (c.charts ?? []).slice(0, 3);
  // the map stays when only the route line is hidden: `parts` is empty, `area` keeps the map's extent
  const area = c.area && c.area.some((p) => p.length >= 2) ? c.area : null;
  const l = shareLayout(o.format, routeless && !area ? 'sticker' : o.background, c.stats.length, charts.length);
  const canvas = document.createElement('canvas');
  canvas.width = l.width;
  canvas.height = l.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  const pal = SHARE_PALETTE[o.theme];
  const sport = c.sportSlot ? pal.series[c.sportSlot - 1]! : pal.other;
  await loadFonts();

  const fit =
    l.route && (!routeless || area)
      ? fitTracks(
          routeless ? area! : c.parts,
          l.width,
          l.height,
          { top: l.route.y, left: l.route.x, right: l.width - l.route.x - l.route.w, bottom: l.height - l.route.y - l.route.h },
          TILE_IMAGE_PX[o.basemap] >= 512 ? -1 : 0,
        )
      : null;

  let map = false;
  let mapFailed = false;
  if (o.background === 'map' && fit) {
    try {
      ctx.fillStyle = pal.bg;
      ctx.fillRect(0, 0, l.width, l.height);
      if (isRasterBasemap(o.basemap) || o.basemap === 'satellite') {
        if (!fit.tiles.length) throw new Error('no tiles');
        const imgs = await Promise.all(fit.tiles.map((tl) => loadTile(tileUrl(o.basemap, tl.z, tl.x, tl.y))));
        fit.tiles.forEach((tl, i) => ctx.drawImage(imgs[i]!, tl.left, tl.top, tl.size + 0.5, tl.size + 0.5));
      } else {
        // the vector map rendered for exactly this canvas (half the size in CSS px at a pixel ratio of 2)
        const url = await mapSnapshot({
          base: o.basemap,
          width: l.width / 2,
          height: l.height / 2,
          pixelRatio: 2,
          view: { cx: fit.view.cx, cy: fit.view.cy, scale: fit.view.scale / 2 },
        });
        if (!url) throw new Error('map unavailable');
        // not cached here: mapSnapshot keeps the image file, a decoded 1080 × 1920 picture is ~8 MB
        ctx.drawImage(await loadImage(url, 30_000), 0, 0, l.width, l.height);
      }
      ctx.getImageData(0, 0, 1, 1); // throws when a tile tainted the canvas
      map = true;
    } catch {
      mapFailed = true;
      ctx.clearRect(0, 0, l.width, l.height);
    }
  }
  if (!map && o.background !== 'sticker') {
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, l.width, l.height);
  }
  if (map) {
    // legibility of the text over the map: nearly opaque behind the text, fading out towards the route
    const headEnd = l.header.y + l.header.h;
    scrim(ctx, pal, 0, headEnd + 90, [
      [0, 0.94],
      [headEnd / (headEnd + 90), 0.86],
      [1, 0],
    ]);
    const statsTop = (l.charts?.y ?? l.stats.y) - 110;
    scrim(ctx, pal, statsTop, l.height, [
      [0, 0],
      [100 / (l.height - statsTop), 0.88],
      [1, 0.94],
    ]);
  }
  if (o.background === 'sticker') {
    // on a photo: a soft halo behind the text
    ctx.shadowColor = o.theme === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.75)';
    ctx.shadowBlur = 14;
  }

  if (fit && !routeless) {
    const w = Math.max(6, Math.round(l.width / 120));
    drawRoute(ctx, fit.parts, sport, w);
    const r = w * 1.6;
    if (c.showEnd) drawFinish(ctx, fit.end[0], fit.end[1], r);
    if (c.showStart) drawStart(ctx, fit.start[0], fit.start[1], r, pal.good);
  }
  drawHeader(ctx, c, l.header, l.font, pal, sport);
  if (l.charts && charts.length) drawCharts(ctx, charts, l.charts, l.font, pal, sport);
  if (c.stats.length) drawStats(ctx, c, l, pal);

  // footer: mark + wordmark left, attribution right
  const fy = l.footer.y + l.footer.h / 2;
  const mark = Math.round(l.font.brand * 1.3);
  drawLogo(ctx, l.footer.x, fy - mark / 2, mark, pal.accent);
  ctx.font = font(700, l.font.brand);
  ctx.fillStyle = pal.fg;
  ctx.textBaseline = 'middle';
  ctx.fillText(c.brand, l.footer.x + mark + 12, fy + 1);
  if (map) {
    ctx.font = font(400, l.font.attribution);
    ctx.fillStyle = pal.fg3;
    ctx.textAlign = 'right';
    ctx.fillText(TILE_ATTRIBUTION[o.basemap], l.footer.x + l.footer.w, fy + 1);
    ctx.textAlign = 'left';
  }
  ctx.shadowColor = 'transparent';
  return { canvas, map, mapFailed };
}

/** PNG of a canvas. */
export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  );
}
