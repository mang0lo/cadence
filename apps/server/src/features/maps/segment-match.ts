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
function toSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d2: number; u: number } {
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
  if (kind === 'end' && n > 1 && side(n - 1) < 0 && Math.hypot(tx[n - 1]! - gx, ty[n - 1]! - gy) <= radius / 2) {
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

/** Share of `points` farther than `tol` from the polyline (and the max distance), using a coarse bounding prefilter. */
function deviation(
  points: [number, number][],
  px: ArrayLike<number>,
  py: ArrayLike<number>,
  tol: number,
): { outlierShare: number; max: number } {
  let outliers = 0;
  let max = 0;
  const tol2 = tol * tol;
  for (const [x, y] of points) {
    let best = Infinity;
    for (let i = 0; i < px.length - 1; i++) {
      // cheap reject: the point is farther than the best so far from the segment's bounding box
      const minX = px[i]! < px[i + 1]! ? px[i]! : px[i + 1]!;
      const maxX = px[i]! < px[i + 1]! ? px[i + 1]! : px[i]!;
      const minY = py[i]! < py[i + 1]! ? py[i]! : py[i + 1]!;
      const maxY = py[i]! < py[i + 1]! ? py[i + 1]! : py[i]!;
      const ddx = x < minX ? minX - x : x > maxX ? x - maxX : 0;
      const ddy = y < minY ? minY - y : y > maxY ? y - maxY : 0;
      if (ddx * ddx + ddy * ddy >= best) continue;
      const { d2 } = toSegment(x, y, px[i]!, py[i]!, px[i + 1]!, py[i + 1]!);
      if (d2 < best) best = d2;
    }
    if (best > tol2) outliers++;
    const d = Math.sqrt(best);
    if (d > max) max = d;
  }
  return { outlierShare: points.length ? outliers / points.length : 0, max };
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
  for (let i = 1; i < n; i++) td[i] = haveDist ? Math.max(td[i - 1]!, track.dist![i]!) : td[i - 1]! + Math.hypot(tx[i]! - tx[i - 1]!, ty[i]! - ty[i - 1]!);

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
  const out: SegmentMatch[] = [];
  let minStart = -Infinity;
  for (const sp of starts) {
    if (sp.pos < minStart) continue;
    for (const ep of ends) {
      if (ep.pos <= sp.pos) continue;
      const len = ep.pos - sp.pos;
      if (len < segLen * LENGTH_RATIO_MIN) continue;
      if (len > segLen * LENGTH_RATIO_MAX) break;
      if (!follows(sp, ep, tx, ty, sx, sy, segPts, tol)) continue;
      const startT = interp(track.t, sp.i, sp.u);
      const endT = interp(track.t, ep.i, ep.u);
      const elapsed = endT - startT;
      if (!(elapsed > 1) || segLen / elapsed > 45) continue; // glitch: not a human speed
      const stats = timeStats(track, sp, ep);
      out.push({ startT, endT, elapsedS: elapsed, movingS: stats.movingS, avgHr: stats.avgHr, trackM: len });
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
  sx: Float64Array,
  sy: Float64Array,
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
  const a = deviation(trackPts, sx, sy, tol);
  if (a.outlierShare > 0.05 || a.max > 2 * tol) return false;
  // 2. the segment is covered by the track (no shortcut)
  const b = deviation(segPts, xs, ys, tol);
  return b.outlierShare <= 0.08 && b.max <= 2.5 * tol;
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
