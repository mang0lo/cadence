/**
 * Share image of an activity (pure parts, no DOM): formats, where every block goes on the canvas, the route with the
 * privacy zones cut out, the file name and the image's own palette. Drawing happens in shareImage.ts.
 */
import type { PrivacyZone } from '@cadence/shared';

export type ShareFormat = 'square' | 'portrait' | 'story';
/** 'map': map tiles behind the route; 'plain': a solid background; 'sticker': transparent, stats only. */
export type ShareBackground = 'map' | 'plain' | 'sticker';
export type ShareTheme = 'light' | 'dark';
/** [lat, lon] */
export type LatLon = [number, number];

export const SHARE_FORMATS: readonly ShareFormat[] = ['square', 'portrait', 'story'];

/** Values that can be shown on the image (each one can be turned on or off). */
export type ShareStatKey =
  | 'distance'
  | 'movingTime'
  | 'elapsedTime'
  | 'pace'
  | 'speed'
  | 'elevation'
  | 'avgHr'
  | 'maxHr'
  | 'avgPower'
  | 'cadence'
  | 'calories'
  | 'effort';
export const SHARE_STAT_KEYS: readonly ShareStatKey[] = [
  'distance',
  'movingTime',
  'elapsedTime',
  'pace',
  'speed',
  'elevation',
  'avgHr',
  'maxHr',
  'avgPower',
  'cadence',
  'calories',
  'effort',
];
/** The layout has room for two rows of three. */
export const MAX_SHARE_STATS = 6;

/** Small charts over the distance (or time) that can be added below the route. */
export type ShareChartKey = 'elevation' | 'pace' | 'heartRate' | 'power';
export const SHARE_CHART_KEYS: readonly ShareChartKey[] = ['elevation', 'pace', 'heartRate', 'power'];
export const MAX_SHARE_CHARTS = 3;

/**
 * What is shown: the stored choice in catalog order, limited to what the activity has; the defaults when nothing of
 * the stored choice is available (or nothing was chosen yet).
 */
export function shareSelection<T extends string>(
  stored: readonly T[] | null,
  available: readonly T[],
  defaults: readonly T[],
  order: readonly T[],
  max: number,
): T[] {
  const has = new Set(available);
  const pick = (list: readonly T[]) => order.filter((k) => list.includes(k) && has.has(k)).slice(0, max);
  if (stored) {
    const chosen = pick(stored);
    // an explicit empty choice stays empty; a choice of only unavailable values falls back to the defaults
    if (chosen.length || !stored.length) return chosen;
  }
  return pick(defaults);
}

/** A mini chart: the values normalized to 0..1 in x (along the activity) and y, split where data is missing. */
export interface ChartSeries {
  parts: [number, number][][];
  min: number;
  max: number;
}

/**
 * Downsample a stream into `buckets` means along x (distance or time) for a small chart. Gaps (no values in a bucket)
 * and track breaks split the line. The y range uses the 2nd–98th percentile so a single spike does not flatten the
 * chart; `minRange` keeps a nearly flat line from being stretched over the whole height.
 */
export function chartSeries(
  x: readonly (number | null | undefined)[],
  y: readonly (number | null | undefined)[],
  opts: { breaks?: readonly number[]; buckets?: number; minRange?: number } = {},
): ChartSeries | null {
  const n = Math.min(x.length, y.length);
  const buckets = opts.buckets ?? 120;
  let x0 = Infinity;
  let x1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const xv = x[i];
    if (xv == null || !Number.isFinite(xv)) continue;
    x0 = Math.min(x0, xv);
    x1 = Math.max(x1, xv);
  }
  if (!(x1 > x0)) return null;
  const sum = new Float64Array(buckets);
  const cnt = new Uint32Array(buckets);
  const brk = new Uint8Array(buckets);
  const breakSet = new Set(opts.breaks ?? []);
  for (let i = 0; i < n; i++) {
    const xv = x[i];
    const yv = y[i];
    if (xv == null || !Number.isFinite(xv)) continue;
    const b = Math.min(buckets - 1, Math.floor(((xv - x0) / (x1 - x0)) * buckets));
    if (breakSet.has(i)) brk[b] = 1;
    if (yv == null || !Number.isFinite(yv)) continue;
    sum[b] += yv;
    cnt[b]++;
  }
  const means: (number | null)[] = Array.from(sum, (v, b) => (cnt[b] ? v / cnt[b]! : null));
  const vals = means.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (vals.length < 2) return null;
  const q = (f: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(f * (vals.length - 1))))]!;
  let lo = q(0.02);
  let hi = q(0.98);
  const minRange = opts.minRange ?? 0;
  if (hi - lo < minRange) {
    const mid = (hi + lo) / 2;
    lo = mid - minRange / 2;
    hi = mid + minRange / 2;
  }
  if (!(hi > lo)) {
    lo -= 1;
    hi += 1;
  }
  const parts: [number, number][][] = [];
  let cur: [number, number][] = [];
  means.forEach((v, b) => {
    if (brk[b] && cur.length) {
      if (cur.length >= 2) parts.push(cur);
      cur = [];
    }
    if (v === null) {
      if (cur.length >= 2) parts.push(cur);
      cur = [];
      return;
    }
    const yn = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    cur.push([(b + 0.5) / buckets, yn]);
  });
  if (cur.length >= 2) parts.push(cur);
  return parts.length ? { parts, min: lo, max: hi } : null;
}

export const SHARE_SIZES: Record<ShareFormat, { width: number; height: number }> = {
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
  story: { width: 1080, height: 1920 },
};

// ---------------------------------------------------------------------------
// Privacy zones
// ---------------------------------------------------------------------------

const EARTH_R = 6371008.8;
const RAD = Math.PI / 180;

/** Meters east / north of a zone's center (equirectangular: exact enough for zones of a few kilometers). */
function local(z: PrivacyZone, p: LatLon): [number, number] {
  return [(p[1] - z.lon) * RAD * EARTH_R * Math.cos(z.lat * RAD), (p[0] - z.lat) * RAD * EARTH_R];
}

/** The part [t0, t1] ⊂ [0, 1] of the segment a → b inside the zone (radius + margin), or null. */
function insideOf(a: LatLon, b: LatLon, z: PrivacyZone, marginM: number): [number, number] | null {
  const [ax, ay] = local(z, a);
  const [bx, by] = local(z, b);
  const dx = bx - ax;
  const dy = by - ay;
  const r = z.radiusM + marginM;
  const qa = dx * dx + dy * dy;
  const qb = 2 * (ax * dx + ay * dy);
  const qc = ax * ax + ay * ay - r * r;
  if (qa === 0) return qc <= 0 ? [0, 1] : null;
  const disc = qb * qb - 4 * qa * qc;
  if (disc <= 0) return null;
  const sq = Math.sqrt(disc);
  const s = Math.max(0, (-qb - sq) / (2 * qa));
  const e = Math.min(1, (-qb + sq) / (2 * qa));
  return e > s ? [s, e] : null;
}

const lerp = (a: LatLon, b: LatLon, f: number): LatLon => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];

export interface PrivacyResult {
  parts: LatLon[][];
  /** Something was cut out. */
  changed: boolean;
  /** The route's first / last point lies in a zone: no start / finish marker (it would mark the zone, not the start). */
  startHidden: boolean;
  endHidden: boolean;
}

/**
 * The route without every stretch inside a privacy zone ({lat, lon, radiusM}). Lines are cut exactly where they enter
 * and leave a zone (plus `marginM`, so rounding never puts a cut point inside), also between two points; a stretch
 * through a zone splits the part in two. Like the heatmap's trimming this hides where activities start and end (at
 * home, at work) — on an image that is shared, also everything else inside a zone.
 */
export function hidePrivacyZones(parts: LatLon[][], zones: PrivacyZone[], marginM = 2): PrivacyResult {
  if (!zones.length) return { parts, changed: false, startHidden: false, endHidden: false };
  const out: LatLon[][] = [];
  let changed = false;
  for (const part of parts) {
    let cur: LatLon[] = [];
    const flush = () => {
      if (cur.length >= 2) out.push(cur);
      cur = [];
    };
    if (part.length === 1 && !zones.some((z) => insideOf(part[0]!, part[0]!, z, marginM))) out.push(part);
    for (let i = 0; i + 1 < part.length; i++) {
      const a = part[i]!;
      const b = part[i + 1]!;
      const inside = zones
        .map((z) => insideOf(a, b, z, marginM))
        .filter((x): x is [number, number] => x !== null)
        .sort((x, y) => x[0] - y[0]);
      if (inside.length) changed = true;
      // the visible pieces: [0, 1] minus the (merged) intervals inside zones
      const pieces: [number, number][] = [];
      let t = 0;
      for (const [s, e] of inside) {
        if (s > t) pieces.push([t, s]);
        t = Math.max(t, e);
      }
      if (t < 1) pieces.push([t, 1]);
      for (const [s, e] of pieces) {
        if (s > 0) flush();
        if (!cur.length) cur.push(s > 0 ? lerp(a, b, s) : a);
        cur.push(e < 1 ? lerp(a, b, e) : b);
        if (e < 1) flush();
      }
      if (!pieces.length) flush();
    }
    flush();
  }
  if (!changed) return { parts, changed: false, startHidden: false, endHidden: false };
  const first = parts.find((p) => p.length)?.[0];
  const lastPart = [...parts].reverse().find((p) => p.length);
  const last = lastPart?.[lastPart.length - 1];
  const outLast = out[out.length - 1];
  return {
    parts: out,
    changed: true,
    startHidden: !out.length || out[0]![0] !== first,
    endHidden: !outLast || outLast[outLast.length - 1] !== last,
  };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ShareLayout {
  width: number;
  height: number;
  /** Sport, title, date and place. */
  header: Rect;
  /** The box the route is fitted into; null for the sticker (stats only). */
  route: Rect | null;
  /** Mini charts side by side (null without charts). */
  charts: Rect | null;
  /** Key stats in `cols` columns × `rows` rows (h = 0 without stats). */
  stats: Rect;
  cols: number;
  rows: number;
  /** Wordmark (left) and map attribution (right). */
  footer: Rect;
  /** Font sizes (px) of the blocks. */
  font: { sport: number; title: number; subtitle: number; label: number; value: number; unit: number; brand: number; attribution: number };
}

/** Header: sport line, up to two title lines, the date/place line. */
const headerHeight = (f: ShareLayout['font']) => Math.round(f.sport * 1.45 + 18 + 2 * f.title * 1.16 + 12 + f.subtitle * 1.3);
const statRowHeight = (f: ShareLayout['font']) => Math.round(f.label * 1.3 + 8 + f.value * 1.1);

/**
 * Where everything goes for a format. Stories keep the top 240 px and bottom 260 px free (the apps' own controls cover
 * them). Up to four stats are one row, five or six two rows of three; a story has two bigger columns. The sticker
 * centers header, stats and wordmark (no route).
 */
export function shareLayout(
  format: ShareFormat,
  background: ShareBackground,
  statCount: number,
  chartCount = 0,
): ShareLayout {
  const { width, height } = SHARE_SIZES[format];
  const story = format === 'story';
  const margin = 64;
  const count = Math.max(0, Math.min(MAX_SHARE_STATS, statCount));
  const cols = Math.max(1, story ? Math.min(2, count) : count <= 4 ? count : 3);
  const rows = Math.ceil(count / cols);
  const font = story
    ? { sport: 30, title: 64, subtitle: 34, label: 30, value: 80, unit: 36, brand: 32, attribution: 22 }
    : { sport: 26, title: 54, subtitle: 30, label: 26, value: cols >= 4 ? 58 : 64, unit: 28, brand: 28, attribution: 20 };
  const header = { x: margin, y: 0, w: width - 2 * margin, h: headerHeight(font) };
  const rowGap = 36;
  const stats = { x: margin, y: 0, w: width - 2 * margin, h: rows ? rows * statRowHeight(font) + (rows - 1) * rowGap : 0 };
  const footer = { x: margin, y: 0, w: width - 2 * margin, h: Math.round(font.brand * 1.5) };
  const charts = chartCount > 0 ? { x: margin, y: 0, w: width - 2 * margin, h: story ? 200 : 150 } : null;
  if (background === 'sticker') {
    const gap = 56;
    const blocks = [header.h, charts?.h ?? 0, stats.h, footer.h].filter((h) => h > 0);
    const total = blocks.reduce((a, b) => a + b, 0) + gap * (blocks.length - 1);
    header.y = Math.round((height - total) / 2);
    let y = header.y + header.h + gap;
    if (charts) {
      charts.y = y;
      y += charts.h + gap;
    }
    stats.y = y;
    footer.y = stats.h ? stats.y + stats.h + gap : y;
    return { width, height, header, route: null, charts, stats, cols, rows, footer, font };
  }
  const top = story ? 240 : margin;
  const bottom = story ? 260 : 52;
  header.y = top;
  footer.y = height - bottom - footer.h;
  stats.y = footer.y - (stats.h ? 40 + stats.h : 0);
  let above = stats.y;
  if (charts) {
    charts.y = above - (stats.h ? 40 : 36) - charts.h;
    above = charts.y;
  }
  const routeTop = header.y + header.h + 36;
  const route = { x: margin, y: routeTop, w: width - 2 * margin, h: Math.max(80, above - 44 - routeTop) };
  return { width, height, header, route, charts, stats, cols, rows, footer, font };
}

// ---------------------------------------------------------------------------
// File name & palette
// ---------------------------------------------------------------------------

const UMLAUTS: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'ae', Ö: 'oe', Ü: 'ue', ß: 'ss' };

/** "Lauf am Morgen – Prater" → "lauf-am-morgen-prater" (ASCII, at most `max` characters). */
export function slugify(s: string, max = 48): string {
  const ascii = s
    .replace(/[äöüÄÖÜß]/g, (c) => UMLAUTS[c]!)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii.slice(0, max).replace(/-+$/, '');
}

/** "cadence-2026-06-20-morning-ride.png" for the local day of the activity and its title. */
export function shareFileName(day: string, title: string): string {
  const slug = slugify(title);
  return `cadence-${day}${slug ? `-${slug}` : ''}.png`;
}

export interface SharePalette {
  /** Plain background. */
  bg: string;
  fg: string;
  fg2: string;
  fg3: string;
  accent: string;
  good: string;
  /** Categorical series 1..8 and "other" (sport colors, see lib/sports.tsx). */
  series: string[];
  other: string;
  /** RGB of the scrims behind text on a map. */
  scrim: [number, number, number];
}

/**
 * Colors of the image. They mirror the design tokens in styles.css; the image's light/dark choice is independent of the
 * app's theme, so the CSS variables (which follow the app) cannot be read.
 */
export const SHARE_PALETTE: Record<ShareTheme, SharePalette> = {
  light: {
    bg: '#f6f6f3',
    fg: '#0b0b0b',
    fg2: '#52514e',
    fg3: '#6d6b66',
    accent: '#e8590c',
    good: '#0ca30c',
    series: ['#eb6834', '#2a78d6', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
    other: '#898781',
    scrim: [255, 255, 255],
  },
  dark: {
    bg: '#0e0e0d',
    fg: '#f0efec',
    fg2: '#c3c2b7',
    fg3: '#9a998f',
    accent: '#f76707',
    good: '#0ca30c',
    series: ['#d95926', '#3987e5', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
    other: '#898781',
    scrim: [14, 14, 13],
  },
};
