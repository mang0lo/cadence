/**
 * Route geometry and coloring for the activity map: a simplified line (for rendering), its length fractions
 * (for line-gradient stops) and per-mode color stops + legend.
 */
import type { ChartTheme } from '@/components/charts/theme';
import { clock, type Formatter } from '@/lib/format';
import { isPaceSport } from './display';
import { haversine, quantile, rampColor, simplifyIndices, type Prepared } from './streams';

export type ColorMode = 'plain' | 'pace' | 'hr' | 'grade' | 'zones';

type Bounds = [number, number, number, number];

export interface RouteGeometry {
  /** Indices into the full-resolution streams of the kept vertices. */
  idx: number[];
  coords: [number, number][];
  /** Fraction of the line length at each vertex (0..1; the jump between track parts adds nothing). */
  frac: Float64Array;
  bounds: Bounds;
  /**
   * Parts of the track as inclusive vertex ranges [first, last] (one part unless the workout was paused and continued
   * elsewhere, see Prepared.breaks), with their bounds. Parts are drawn as separate lines.
   */
  parts: { v0: number; v1: number; bounds: Bounds }[];
}

function boundsOfCoords(coords: [number, number][], a = 0, b = coords.length - 1): Bounds {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (let k = a; k <= b; k++) {
    const [lo, la] = coords[k]!;
    minLon = Math.min(minLon, lo);
    maxLon = Math.max(maxLon, lo);
    minLat = Math.min(minLat, la);
    maxLat = Math.max(maxLat, la);
  }
  return [minLon, minLat, maxLon, maxLat];
}

export function routeGeometry(P: Prepared, toleranceM = 2): RouteGeometry | null {
  if (!P.lat || !P.lon) return null;
  const idx: number[] = [];
  const parts: RouteGeometry['parts'] = [];
  // simplify every part on its own so a part boundary is always a vertex
  const cuts = [0, ...P.breaks, P.n];
  for (let p = 0; p + 1 < cuts.length; p++) {
    const a = cuts[p]!;
    const b = cuts[p + 1]!;
    if (b - a < 1) continue;
    const local = simplifyIndices(P.lat.subarray(a, b), P.lon.subarray(a, b), toleranceM);
    const v0 = idx.length;
    for (const i of local) idx.push(a + i);
    parts.push({ v0, v1: idx.length - 1, bounds: [0, 0, 0, 0] });
  }
  const coords = idx.map((i) => [P.lon![i]!, P.lat![i]!] as [number, number]);
  const frac = new Float64Array(idx.length);
  const firstOfPart = new Set(parts.map((p) => p.v0));
  for (let k = 1; k < idx.length; k++)
    frac[k] =
      frac[k - 1]! +
      (firstOfPart.has(k) ? 0 : haversine(coords[k - 1]![1], coords[k - 1]![0], coords[k]![1], coords[k]![0]));
  const total = frac[frac.length - 1] || 1;
  for (let k = 0; k < frac.length; k++) frac[k] = frac[k]! / total;
  for (const p of parts) p.bounds = boundsOfCoords(coords, p.v0, p.v1);
  return { idx, coords, frac, bounds: boundsOfCoords(coords), parts };
}

/** Index of the part that contains vertex k. */
export function partOfVertex(g: RouteGeometry, k: number): number {
  for (let p = g.parts.length - 1; p > 0; p--) if (k >= g.parts[p]!.v0) return p;
  return 0;
}

/** Coordinates of the vertices a..b (inclusive) as separate lines, one per track part they touch. */
export function coordsByPart(g: RouteGeometry, a: number, b: number): [number, number][][] {
  const out: [number, number][][] = [];
  for (const p of g.parts) {
    const s = Math.max(a, p.v0);
    const e = Math.min(b, p.v1);
    if (e > s) out.push(g.coords.slice(s, e + 1));
  }
  return out;
}

/** Gradient stops of one part, re-scaled from the fractions of the whole route to the part's own 0..1. */
export function partStops(g: RouteGeometry, stops: [number, string][], part: number): [number, string][] {
  const p = g.parts[part]!;
  const f0 = g.frac[p.v0]!;
  const f1 = g.frac[p.v1]!;
  if (g.parts.length === 1 || !(f1 > f0)) return stops;
  const out: [number, string][] = [[0, colorAtFrac(stops, f0)]];
  for (const [f, c] of stops) if (f > f0 && f < f1) out.push([(f - f0) / (f1 - f0), c]);
  out.push([1, colorAtFrac(stops, f1)]);
  return out;
}

/** First vertex index whose stream index is greater than `fi` (binary search). */
export function vertexAfter(g: RouteGeometry, fi: number): number {
  let lo = 0;
  let hi = g.idx.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (g.idx[mid]! <= fi) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type Legend =
  | { kind: 'ramp'; colors: string[]; from: string; to: string; fromLabel: string; toLabel: string }
  | { kind: 'zones'; items: { color: string; label: string }[] };

export interface RouteColoring {
  stops: [number, string][];
  legend: Legend;
}

/** Mean of `arr` over the samples between consecutive vertices (vertex k covers idx[k−1]..idx[k]). */
function vertexValues(g: RouteGeometry, arr: Float64Array, movingOnly: Uint8Array | null): Float64Array {
  const out = new Float64Array(g.idx.length).fill(NaN);
  for (let k = 0; k < g.idx.length; k++) {
    const a = k ? g.idx[k - 1]! + 1 : 0;
    const b = g.idx[k]!;
    let s = 0;
    let c = 0;
    for (let i = a; i <= b; i++) {
      if (movingOnly && !movingOnly[i]) continue;
      const v = arr[i]!;
      if (v === v) {
        s += v;
        c++;
      }
    }
    out[k] = c ? s / c : NaN;
  }
  // fill gaps from neighbours so the gradient never has holes
  let last = NaN;
  for (let k = 0; k < out.length; k++) {
    if (out[k] === out[k]) last = out[k]!;
    else out[k] = last;
  }
  let next = NaN;
  for (let k = out.length - 1; k >= 0; k--) {
    if (out[k] === out[k]) next = out[k]!;
    else out[k] = next;
  }
  return out;
}

/** At most `max` stops: average consecutive vertices. */
function limitStops(frac: Float64Array, colorsOf: (k0: number, k1: number) => string, max = 256): [number, string][] {
  const m = frac.length;
  const step = Math.max(1, Math.ceil(m / max));
  const out: [number, string][] = [];
  for (let k = 0; k < m; k += step) {
    const k1 = Math.min(m - 1, k + step - 1);
    out.push([(frac[k]! + frac[k1]!) / 2, colorsOf(k, k1)]);
  }
  if (out.length) {
    out[0]![0] = 0;
    out[out.length - 1]![0] = 1;
  }
  return out;
}

function meanRange(v: Float64Array, k0: number, k1: number): number {
  let s = 0;
  let c = 0;
  for (let k = k0; k <= k1; k++)
    if (v[k] === v[k]) {
      s += v[k]!;
      c++;
    }
  return c ? s / c : NaN;
}

/** Color of the gradient stop closest to fraction `f` (stops sorted by fraction). */
export function colorAtFrac(stops: [number, string][], f: number): string {
  let lo = 0;
  let hi = stops.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (stops[mid]![0] <= f) lo = mid;
    else hi = mid;
  }
  const a = stops[lo]!;
  const b = stops[hi]!;
  return Math.abs(a[0] - f) <= Math.abs(b[0] - f) ? a[1] : b[1];
}

export interface RouteChunks {
  /** Vertices per chunk; chunk c spans vertices [c·size, (c+1)·size] (endpoints shared). */
  size: number;
  count: number;
  /** Color per chunk (null = the plain route color of the current basemap). */
  colors: (string | null)[];
}

/** The route cut into ≤ `max` chunks, each with one color: the travelled part is drawn chunk by chunk. */
export function routeChunks(g: RouteGeometry, stops: [number, string][] | null, max = 240): RouteChunks {
  const m = g.coords.length;
  const size = Math.max(1, Math.ceil((m - 1) / max));
  const count = Math.max(1, Math.ceil((m - 1) / size));
  const colors: (string | null)[] = [];
  for (let c = 0; c < count; c++) {
    const a = c * size;
    const b = Math.min(m - 1, a + size);
    colors.push(stops ? colorAtFrac(stops, (g.frac[a]! + g.frac[b]!) / 2) : null);
  }
  return { size, count, colors };
}

export function zoneOf(hr: number, bounds: number[]): number {
  for (let i = 0; i < bounds.length; i++) if (hr < bounds[i]!) return i;
  return bounds.length;
}

/** Which color modes make sense for these streams. */
export function availableModes(P: Prepared): ColorMode[] {
  const out: ColorMode[] = ['plain'];
  if (P.speed && P.dist) out.push('pace');
  if (P.hr) out.push('hr', 'zones');
  if (P.grade) out.push('grade');
  return out;
}

export function routeColoring(
  mode: ColorMode,
  P: Prepared,
  g: RouteGeometry,
  theme: ChartTheme,
  o: { sport: string; zoneBounds: number[]; fmt: Formatter; labels: Record<string, string>; zoneLabels: string[] },
): RouteColoring | null {
  if (mode === 'plain') return null;
  if (mode === 'pace' && P.speed) {
    const v = vertexValues(g, P.speed, P.moving);
    const lo = quantile(v, 0.05);
    const hi = quantile(v, 0.95);
    if (!(hi > lo)) return null;
    const ramp = theme.seq;
    const stops = limitStops(g.frac, (a, b) => rampColor(ramp, (meanRange(v, a, b) - lo) / (hi - lo)));
    const pace = isPaceSport(o.sport);
    const label = (mps: number) => (pace ? `${clock(o.fmt.paceSeconds(mps))}` : o.fmt.speed(mps));
    return {
      stops,
      legend: { kind: 'ramp', colors: ramp, from: label(lo), to: label(hi), fromLabel: o.labels.slow!, toLabel: o.labels.fast! },
    };
  }
  if (mode === 'hr' && P.hr) {
    const v = vertexValues(g, P.hr, null);
    const lo = quantile(v, 0.05);
    const hi = quantile(v, 0.95);
    if (!(hi > lo)) return null;
    const ramp = theme.zones;
    return {
      stops: limitStops(g.frac, (a, b) => rampColor(ramp, (meanRange(v, a, b) - lo) / (hi - lo))),
      legend: { kind: 'ramp', colors: ramp, from: `${Math.round(lo)}`, to: `${Math.round(hi)} bpm`, fromLabel: o.labels.low!, toLabel: o.labels.high! },
    };
  }
  if (mode === 'zones' && P.hr) {
    const v = vertexValues(g, P.hr, null);
    return {
      stops: limitStops(g.frac, (a, b) => theme.zones[zoneOf(meanRange(v, a, b), o.zoneBounds)] ?? theme.zones[0]!),
      legend: { kind: 'zones', items: theme.zones.map((color, i) => ({ color, label: o.zoneLabels[i] ?? `Z${i + 1}` })) },
    };
  }
  if (mode === 'grade' && P.grade) {
    const v = vertexValues(g, P.grade, null);
    const ramp = [theme.diverging.neg, theme.diverging.mid, theme.diverging.pos];
    const max = 0.1;
    return {
      stops: limitStops(g.frac, (a, b) => rampColor(ramp, (meanRange(v, a, b) + max) / (2 * max))),
      legend: { kind: 'ramp', colors: ramp, from: '−10 %', to: '+10 %', fromLabel: o.labels.downhill!, toLabel: o.labels.uphill! },
    };
  }
  return null;
}
