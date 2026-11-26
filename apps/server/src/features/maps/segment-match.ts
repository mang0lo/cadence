/**
 * Segment matching: find the passes of a GPS track through a segment (near its start, then near its end, in that
 * order, following the segment's course in between) and time them with interpolated gate crossings.
 * Pure functions on arrays – no database – so the geometry is unit tested on its own.
 */
import { MIN_SEGMENT_M, valueAtDistance } from '@cadence/shared';
import { EARTH_RADIUS_M, simplifyIndices } from '../../lib/geo';

/** A track has to come this close to the start / end point of the segment. */
export const GATE_RADIUS_M = 30;
/** … and stay this close to the segment's course in between (and vice versa). */
export const FOLLOW_TOLERANCE_M = 40;
/** Track distance between start and end gate relative to the segment length. */
export const LENGTH_RATIO_MIN = 0.85;
export const LENGTH_RATIO_MAX = 1.2;

export interface SegmentPath {
  lat: number[];
  lon: number[];
  /** Cumulative distance along the segment in meters (first value 0). */
  dist: number[];
  ele?: (number | null)[];
}

export interface MatchTrack {
  /** Seconds since the workout start. */
  t: ArrayLike<number>;
  lat: ArrayLike<number>;
  lon: ArrayLike<number>;
  /** Cumulative distance; computed from the coordinates when missing. */
  dist?: ArrayLike<number>;
  hr?: ArrayLike<number | null>;
  /** 1 while moving. */
  moving?: ArrayLike<number>;
}

export interface SegmentMatch {
  /** Interpolated gate crossing times, seconds since the workout start. */
  startT: number;
  endT: number;
  elapsedS: number;
  movingS: number | null;
  avgHr: number | null;
  /** Track distance between the two gate crossings (m). */
  trackM: number;
}

const RAD = Math.PI / 180;

/** Squared distance of p to segment a–b and the position (0..1) of the closest point on it. */
function toSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { d2: number; u: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let u = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const cx = ax + dx * u - px;
  const cy = ay + dy * u - py;
  return { d2: cx * cx + cy * cy, u };
}

interface Pass {
  /** Track segment index and position inside it. */
  i: number;
  u: number;
  /** Distance travelled along the track at the crossing. */
  pos: number;
  /** Offset of the crossing from the gate point (m). */
  d: number;
}

/**
 * Where a track crosses a gate: the line through the gate point `g` perpendicular to the segment's direction `dir`
 * there, crossed in that direction, within `radius` of the gate point. A track that starts (or ends) right at the
 * gate without crossing it counts with its first (last) fix when that is within half the radius.
 */
function gateCrossings(
  kind: 'start' | 'end',
  gx: number,
  gy: number,
  dirX: number,
  dirY: number,
  tx: Float64Array,
  ty: Float64Array,
  td: Float64Array,
  radius: number,
): Pass[] {
  const n = tx.length;
  const out: Pass[] = [];
  const side = (i: number) => (tx[i]! - gx) * dirX + (ty[i]! - gy) * dirY;
  // lateral offset of a point from the gate point (perpendicular to the direction)
  const lateral = (x: number, y: number) => Math.abs(-(x - gx) * dirY + (y - gy) * dirX);
  if (kind === 'start' && n > 0 && side(0) >= 0 && Math.hypot(tx[0]! - gx, ty[0]! - gy) <= radius / 2) {
    out.push({ i: 0, u: 0, pos: td[0]!, d: Math.hypot(tx[0]! - gx, ty[0]! - gy) });
  }
  let prev = side(0);
  for (let i = 0; i < n - 1; i++) {
    const next = side(i + 1);
    if (prev < 0 && next >= 0) {
      const u = next === prev ? 0 : -prev / (next - prev);
      const qx = tx[i]! + u * (tx[i + 1]! - tx[i]!);
      const qy = ty[i]! + u * (ty[i + 1]! - ty[i]!);
      const d = lateral(qx, qy);
      if (d <= radius) out.push({ i, u, pos: td[i]! + u * (td[i + 1]! - td[i]!), d });
    }
    prev = next;
  }
  if (
    kind === 'end' &&
    n > 1 &&
    side(n - 1) < 0 &&
    Math.hypot(tx[n - 1]! - gx, ty[n - 1]! - gy) <= radius / 2
  ) {
    out.push({ i: n - 2, u: 1, pos: td[n - 1]!, d: Math.hypot(tx[n - 1]! - gx, ty[n - 1]! - gy) });
  }
  return out;
}

/** Points every ~`stepM` meters along a polyline given as projected coordinates. */
function sampleAlong(xs: ArrayLike<number>, ys: ArrayLike<number>, stepM: number): [number, number][] {
  const out: [number, number][] = [];
  if (!xs.length) return out;
  out.push([xs[0]!, ys[0]!]);
  let carry = 0;
  for (let i = 1; i < xs.length; i++) {
    const dx = xs[i]! - xs[i - 1]!;
    const dy = ys[i]! - ys[i - 1]!;
    const len = Math.hypot(dx, dy);
    let pos = stepM - carry;
    while (pos <= len) {
      const f = len > 0 ? pos / len : 0;
      out.push([xs[i - 1]! + dx * f, ys[i - 1]! + dy * f]);
      pos += stepM;
    }
    carry = len - (pos - stepM);
  }
  out.push([xs[xs.length - 1]!, ys[ys.length - 1]!]);
  return out;
}

/** Cell keys stay unique while |cell y| < 2^21 (40 000 km at 20 m cells). */
const CELL_KEY = 4_194_304;
/** Edges longer than this many cells (a GPS glitch) are not put in cells but measured by every query. */
const LONG_EDGE_CELLS = 64;

/**
 * The edges of a polyline (local planar meters) in a uniform grid: the nearest edge to a point is found by looking at
 * the cells around it, ring by ring, instead of at every edge. Linear to build, so a long segment or track part no
 * longer makes the "follows the course" test quadratic.
 */
class EdgeGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly long: number[] = [];
  /** Query stamp per edge: an edge listed in several cells is measured once per query. */
  private readonly seen: Uint32Array;
  private query = 0;

  constructor(
    private readonly px: ArrayLike<number>,
    private readonly py: ArrayLike<number>,
    private readonly cell: number,
  ) {
    const edges = Math.max(0, px.length - 1);
    this.seen = new Uint32Array(edges);
    for (let i = 0; i < edges; i++) {
      // an edge is listed in every cell that the bounding box of one of its pieces (≤ one cell long) touches, so it is
      // listed in the cell of each of its points; distances are always measured to the whole edge
      const ax = px[i]!;
      const ay = py[i]!;
      const dx = px[i + 1]! - ax;
      const dy = py[i + 1]! - ay;
      const pieces = Math.max(1, Math.ceil(Math.hypot(dx, dy) / cell));
      if (pieces > LONG_EDGE_CELLS) {
        this.long.push(i);
        continue;
      }
      for (let k = 0; k < pieces; k++) {
        const x0 = ax + (dx * k) / pieces;
        const x1 = ax + (dx * (k + 1)) / pieces;
        const y0 = ay + (dy * k) / pieces;
        const y1 = ay + (dy * (k + 1)) / pieces;
        const cx1 = Math.floor(Math.max(x0, x1) / cell);
        const cy1 = Math.floor(Math.max(y0, y1) / cell);
        for (let cx = Math.floor(Math.min(x0, x1) / cell); cx <= cx1; cx++)
          for (let cy = Math.floor(Math.min(y0, y1) / cell); cy <= cy1; cy++) {
            const key = cx * CELL_KEY + cy;
            const list = this.cells.get(key);
            if (list === undefined) this.cells.set(key, [i]);
            else if (list[list.length - 1] !== i) list.push(i);
          }
      }
    }
  }

  /**
   * Squared distance from (x, y) to the nearest edge – exact whenever that distance is ≤ `maxDist`, otherwise some
   * value above maxDist² (Infinity when no edge is that close).
   */
  nearest2(x: number, y: number, maxDist: number): number {
    const { px, py, cell, cells, seen } = this;
    const q = ++this.query;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    let best = Infinity;
    for (const e of this.long) {
      const { d2 } = toSegment(x, y, px[e]!, py[e]!, px[e + 1]!, py[e + 1]!);
      if (d2 < best) best = d2;
    }
    for (let r = 0; ; r++) {
      // the ring of cells r steps away from the point's cell
      for (let i = cx - r; i <= cx + r; i++) {
        const edge = i === cx - r || i === cx + r;
        for (let j = cy - r; j <= cy + r; j += edge ? 1 : 2 * r) {
          const list = cells.get(i * CELL_KEY + j);
          if (list !== undefined)
            for (const e of list) {
              if (seen[e] === q) continue;
              seen[e] = q;
              const { d2 } = toSegment(x, y, px[e]!, py[e]!, px[e + 1]!, py[e + 1]!);
              if (d2 < best) best = d2;
            }
        }
      }
      // every edge closer than r cells has been measured: done when the best one is that close, or beyond maxDist
      const reach = r * cell;
      if (best <= reach * reach || reach > maxDist) return best;
    }
  }
}

/**
 * Do the `points` lie on the polyline of `grid`: at most `maxShare` of them farther than `tol` from it (GPS outliers)
 * and none farther than `maxDist`?
 */
function staysNear(
  points: [number, number][],
  grid: EdgeGrid,
  tol: number,
  maxShare: number,
  maxDist: number,
): boolean {
  let outliers = 0;
  const tol2 = tol * tol;
  for (const [x, y] of points) {
    const best = grid.nearest2(x, y, maxDist);
    if (best > tol2 && ++outliers / points.length > maxShare) return false;
    if (Math.sqrt(best) > maxDist) return false;
  }
  return true;
}

export interface MatchOptions {
  gateRadiusM?: number;
  followToleranceM?: number;
}

/**
 * All passes of `track` through `seg`: the track crosses the segment's start gate, later its end gate, the distance
 * between the two is about the segment's length and the track follows the segment's course in between. Passes never
 * overlap (a lap on a loop segment is one effort per lap). Times are interpolated at the gate crossings.
 */
export function matchSegment(seg: SegmentPath, track: MatchTrack, opts: MatchOptions = {}): SegmentMatch[] {
  const gate = opts.gateRadiusM ?? GATE_RADIUS_M;
  const tol = opts.followToleranceM ?? FOLLOW_TOLERANCE_M;
  const m = seg.lat.length;
  const n = Math.min(track.lat.length, track.lon.length, track.t.length);
  const segLen = seg.dist[m - 1] ?? 0;
  if (m < 2 || n < 2 || segLen < MIN_SEGMENT_M) return [];

  // local planar coordinates (meters) around the segment's start
  const lat0 = seg.lat[0]!;
  const lon0 = seg.lon[0]!;
  const ky = EARTH_RADIUS_M * RAD;
  const kx = ky * Math.cos(lat0 * RAD);
  const sx = new Float64Array(m);
  const sy = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    sx[i] = (seg.lon[i]! - lon0) * kx;
    sy[i] = (seg.lat[i]! - lat0) * ky;
  }
  const tx = new Float64Array(n);
  const ty = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    tx[i] = (track.lon[i]! - lon0) * kx;
    ty[i] = (track.lat[i]! - lat0) * ky;
  }
  const td = new Float64Array(n);
  const haveDist = !!track.dist && track.dist.length >= n;
  for (let i = 1; i < n; i++)
    td[i] = haveDist
      ? Math.max(td[i - 1]!, track.dist![i]!)
      : td[i - 1]! + Math.hypot(tx[i]! - tx[i - 1]!, ty[i]! - ty[i - 1]!);

  // gate directions: the segment's heading over its first / last ~20 m
  let js = 1;
  while (js < m - 1 && seg.dist[js]! < 20) js++;
  let je = m - 2;
  while (je > 0 && segLen - seg.dist[je]! < 20) je--;
  const unit = (x: number, y: number, fx: number, fy: number): [number, number] => {
    const l = Math.hypot(x, y);
    if (l > 0) return [x / l, y / l];
    const f = Math.hypot(fx, fy) || 1;
    return [fx / f, fy / f];
  };
  const fullX = sx[m - 1]! - sx[0]!;
  const fullY = sy[m - 1]! - sy[0]!;
  const [sdx, sdy] = unit(sx[js]! - sx[0]!, sy[js]! - sy[0]!, fullX, fullY);
  const [edx, edy] = unit(sx[m - 1]! - sx[je]!, sy[m - 1]! - sy[je]!, fullX, fullY);
  const starts = gateCrossings('start', sx[0]!, sy[0]!, sdx, sdy, tx, ty, td, gate);
  if (!starts.length) return [];
  const ends = gateCrossings('end', sx[m - 1]!, sy[m - 1]!, edx, edy, tx, ty, td, gate);
  if (!ends.length) return [];

  const segPts = sampleAlong(sx, sy, 20);
  let segGrid: EdgeGrid | null = null;
  /** The pass from `sp` to `ep`, or null when its length, course or speed rule it out. */
  const pass = (sp: Pass, ep: Pass): SegmentMatch | null => {
    const len = ep.pos - sp.pos;
    if (len < segLen * LENGTH_RATIO_MIN || len > segLen * LENGTH_RATIO_MAX) return null;
    segGrid ??= new EdgeGrid(sx, sy, tol / 2);
    if (!follows(sp, ep, tx, ty, segGrid, segPts, tol)) return null;
    const startT = interp(track.t, sp.i, sp.u);
    const endT = interp(track.t, ep.i, ep.u);
    const elapsed = endT - startT;
    if (!(elapsed > 1) || segLen / elapsed > 45) return null; // glitch: not a human speed
    const stats = timeStats(track, sp, ep);
    return { startT, endT, elapsedS: elapsed, movingS: stats.movingS, avgHr: stats.avgHr, trackM: len };
  };
  const out: SegmentMatch[] = [];
  let minStart = -Infinity;
  for (let si = 0; si < starts.length; si++) {
    const sp = starts[si]!;
    if (sp.pos < minStart) continue;
    for (const ep of ends) {
      if (ep.pos <= sp.pos) continue;
      const len = ep.pos - sp.pos;
      if (len < segLen * LENGTH_RATIO_MIN) continue;
      if (len > segLen * LENGTH_RATIO_MAX) break;
      let m = pass(sp, ep);
      if (!m) continue;
      // the effort starts at the LAST start crossing before this end that still makes a valid pass: waiting at the
      // start line (GPS jitter across it), a turn back or a warm-up stride there is not part of the effort
      for (let k = starts.length - 1; k > si; k--) {
        if (ep.pos - starts[k]!.pos < segLen * LENGTH_RATIO_MIN) continue;
        const later = pass(starts[k]!, ep);
        if (later) {
          m = later;
          break;
        }
      }
      out.push(m);
      minStart = ep.pos;
      break;
    }
  }
  return out;
}

const interp = (t: ArrayLike<number>, i: number, u: number): number => t[i]! + u * (t[i + 1]! - t[i]!);

/** Does the track part between the two passes follow the segment (and the segment lie on the track part)? */
function follows(
  sp: Pass,
  ep: Pass,
  tx: Float64Array,
  ty: Float64Array,
  segGrid: EdgeGrid,
  segPts: [number, number][],
  tol: number,
): boolean {
  // track part as a polyline: interpolated start point, the fixes in between, interpolated end point
  const xs: number[] = [tx[sp.i]! + sp.u * (tx[sp.i + 1]! - tx[sp.i]!)];
  const ys: number[] = [ty[sp.i]! + sp.u * (ty[sp.i + 1]! - ty[sp.i]!)];
  for (let k = sp.i + 1; k <= ep.i; k++) {
    xs.push(tx[k]!);
    ys.push(ty[k]!);
  }
  xs.push(tx[ep.i]! + ep.u * (tx[ep.i + 1]! - tx[ep.i]!));
  ys.push(ty[ep.i]! + ep.u * (ty[ep.i + 1]! - ty[ep.i]!));
  const trackPts = sampleAlong(xs, ys, 15);
  // 1. the track stays on the segment (a few GPS outliers are tolerated, none beyond twice the tolerance)
  if (!staysNear(trackPts, segGrid, tol, 0.05, 2 * tol)) return false;
  // 2. the segment is covered by the track (no shortcut)
  return staysNear(segPts, new EdgeGrid(xs, ys, tol / 2), tol, 0.08, 2.5 * tol);
}

function timeStats(track: MatchTrack, sp: Pass, ep: Pass): { movingS: number | null; avgHr: number | null } {
  let moving = 0;
  let hrSum = 0;
  let hrW = 0;
  let any = false;
  for (let k = sp.i + 1; k <= ep.i; k++) {
    const dt = Math.min(track.t[k]! - track.t[k - 1]!, 600);
    if (!(dt > 0)) continue;
    if (track.moving) {
      any = true;
      if (track.moving[k]) moving += dt;
    }
    const hr = track.hr?.[k];
    if (hr != null && Number.isFinite(hr)) {
      hrSum += hr * dt;
      hrW += dt;
    }
  }
  return { movingS: any ? moving : null, avgHr: hrW > 0 ? hrSum / hrW : null };
}

// ---------------------------------------------------------------------------------------------------------------
// Building a segment from a workout stream
// ---------------------------------------------------------------------------------------------------------------

export interface StreamLike {
  lat: ArrayLike<number>;
  lon: ArrayLike<number>;
  dist: ArrayLike<number>;
  ele?: ArrayLike<number | null>;
  t?: ArrayLike<number>;
}

/** The part of a stream between two distances, with interpolated end points; `dist` restarts at 0. */
export function sliceStream(s: StreamLike, startM: number, endM: number): SegmentPath {
  const n = Math.min(s.lat.length, s.lon.length, s.dist.length);
  const lat: number[] = [];
  const lon: number[] = [];
  const dist: number[] = [];
  const ele: (number | null)[] = [];
  const at = (d: number) => {
    lat.push(valueAtDistance(s.dist, s.lat, d)!);
    lon.push(valueAtDistance(s.dist, s.lon, d)!);
    ele.push(s.ele ? valueAtDistance(s.dist, s.ele, d) : null);
    dist.push(d - startM);
  };
  at(startM);
  for (let i = 0; i < n; i++) {
    const d = s.dist[i]!;
    if (d <= startM || d >= endM) continue;
    lat.push(s.lat[i]!);
    lon.push(s.lon[i]!);
    ele.push(s.ele?.[i] ?? null);
    dist.push(d - startM);
  }
  at(endM);
  return { lat, lon, dist, ele };
}

/** Douglas–Peucker thinning (meters) that keeps the cumulative distance and elevation of the kept points. */
export function thinPath(p: SegmentPath, toleranceM = 1.5): SegmentPath {
  const keep = simplifyIndices(p.lat, p.lon, toleranceM);
  return {
    lat: keep.map((i) => p.lat[i]!),
    lon: keep.map((i) => p.lon[i]!),
    dist: keep.map((i) => p.dist[i]!),
    ele: p.ele ? keep.map((i) => p.ele![i] ?? null) : undefined,
  };
}
