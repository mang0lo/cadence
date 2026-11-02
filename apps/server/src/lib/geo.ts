import { POLYLINE_PART_SEPARATOR, polylineParts } from '@cadence/shared';
/**
 * Geo helpers shared by the importer, derivation and feature modules (maps, activities, …).
 * Coordinates are WGS84 degrees; distances are meters. Point tuples are always `[lat, lon]`
 * (Google polyline order); bounding boxes are `[minLon, minLat, maxLon, maxLat]` (GeoJSON / WorkoutDetail order).
 */

export const EARTH_RADIUS_M = 6371008.8;
const RAD = Math.PI / 180;

export type LatLon = [lat: number, lon: number];
export type BBox = [minLon: number, minLat: number, maxLon: number, maxLat: number];

/** Great-circle distance in meters. */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h = s1 * s1 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * s2 * s2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from point 1 to point 2 in degrees (0 = north, clockwise, 0..360). */
export function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * RAD;
  const p2 = lat2 * RAD;
  const dl = (lon2 - lon1) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Point reached from (lat, lon) after `distanceM` meters on initial bearing `bearingDeg`. */
export function destination(lat: number, lon: number, bearingDeg: number, distanceM: number): LatLon {
  const d = distanceM / EARTH_RADIUS_M;
  const b = bearingDeg * RAD;
  const p1 = lat * RAD;
  const l1 = lon * RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 =
    l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / RAD, ((((l2 / RAD + 540) % 360) + 360) % 360) - 180];
}

/** Cumulative distance along a track (first element 0). */
export function cumulativeDistance(lat: ArrayLike<number>, lon: ArrayLike<number>): Float64Array {
  const n = lat.length;
  const out = new Float64Array(n);
  for (let i = 1; i < n; i++) out[i] = out[i - 1]! + haversine(lat[i - 1]!, lon[i - 1]!, lat[i]!, lon[i]!);
  return out;
}

/** Total length of a path in meters. */
export function pathLength(points: ArrayLike<LatLon>): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    d += haversine(a[0], a[1], b[0], b[1]);
  }
  return d;
}

/** Bounding box `[minLon, minLat, maxLon, maxLat]`, or null for an empty input. */
export function bounds(lat: ArrayLike<number>, lon: ArrayLike<number>): BBox | null {
  const n = lat.length;
  if (!n) return null;
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = lat[i]!;
    const o = lon[i]!;
    if (a < minLat) minLat = a;
    if (a > maxLat) maxLat = a;
    if (o < minLon) minLon = o;
    if (o > maxLon) maxLon = o;
  }
  return [minLon, minLat, maxLon, maxLat];
}

/** Squared distance of point p to segment a–b in a planar (projected, meters) space. */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  let dx = bx - ax;
  let dy = by - ay;
  if (dx !== 0 || dy !== 0) {
    const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      ax = bx;
      ay = by;
    } else if (t > 0) {
      ax += dx * t;
      ay += dy * t;
    }
  }
  dx = px - ax;
  dy = py - ay;
  return dx * dx + dy * dy;
}

/**
 * Douglas–Peucker simplification (iterative, no recursion limit). Works in a local equirectangular
 * projection, so `toleranceM` is in meters. Returns the indices of the points to keep (always first and last).
 */
export function simplifyIndices(
  lat: ArrayLike<number>,
  lon: ArrayLike<number>,
  toleranceM: number,
): number[] {
  const n = lat.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  let latSum = 0;
  for (let i = 0; i < n; i++) latSum += lat[i]!;
  const ky = EARTH_RADIUS_M * RAD;
  const kx = ky * Math.cos((latSum / n) * RAD);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = lon[i]! * kx;
    y[i] = lat[i]! * ky;
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = toleranceM * toleranceM;
  const stack: number[] = [0, n - 1];
  while (stack.length) {
    const last = stack.pop()!;
    const first = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    const ax = x[first]!;
    const ay = y[first]!;
    const bx = x[last]!;
    const by = y[last]!;
    for (let i = first + 1; i < last; i++) {
      const d = segDist2(x[i]!, y[i]!, ax, ay, bx, by);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tol2) {
      keep[idx] = 1;
      stack.push(first, idx, idx, last);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/** Douglas–Peucker simplification of `[lat, lon]` points with a tolerance in meters. */
export function simplifyPath(points: LatLon[], toleranceM = 5): LatLon[] {
  const lat = points.map((p) => p[0]);
  const lon = points.map((p) => p[1]);
  return simplifyIndices(lat, lon, toleranceM).map((i) => points[i]!);
}

function encodeSigned(v: number, out: string[]): void {
  let n = v < 0 ? ~(v << 1) : v << 1;
  while (n >= 0x20) {
    out.push(String.fromCharCode((0x20 | (n & 0x1f)) + 63));
    n >>>= 5;
  }
  out.push(String.fromCharCode(n + 63));
}

/** Google encoded polyline of `[lat, lon]` points (default precision 5 ≈ 1 m). */
export function encodePolyline(points: ArrayLike<LatLon>, precision = 5): string {
  const factor = 10 ** precision;
  const out: string[] = [];
  let pLat = 0;
  let pLon = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const lat = Math.round(p[0] * factor);
    const lon = Math.round(p[1] * factor);
    encodeSigned(lat - pLat, out);
    encodeSigned(lon - pLon, out);
    pLat = lat;
    pLon = lon;
  }
  return out.join('');
}

/** Encode separate lat/lon arrays (optionally only the given indices). */
export function encodePolylineArrays(
  lat: ArrayLike<number>,
  lon: ArrayLike<number>,
  indices?: ArrayLike<number>,
  precision = 5,
): string {
  const n = indices ? indices.length : lat.length;
  const pts: LatLon[] = new Array(n);
  for (let k = 0; k < n; k++) {
    const i = indices ? indices[k]! : k;
    pts[k] = [lat[i]!, lon[i]!];
  }
  return encodePolyline(pts, precision);
}

/**
 * Decode a (possibly multi-part, see POLYLINE_PART_SEPARATOR) encoded polyline into one list of `[lat, lon]`
 * points. Use decodePolylineParts to draw or measure the parts separately.
 */
export function decodePolyline(str: string, precision = 5): LatLon[] {
  if (str.includes(POLYLINE_PART_SEPARATOR)) return decodePolylineParts(str, precision).flat();
  return decodeOnePolyline(str, precision);
}

/** The parts of a multi-part polyline (a single part for ordinary routes). */
export function decodePolylineParts(str: string, precision = 5): LatLon[][] {
  return polylineParts(str).map((p) => decodeOnePolyline(p, precision));
}

/** Encode route parts as one multi-part polyline (parts with fewer than 2 points are dropped). */
export function encodePolylineParts(parts: ArrayLike<LatLon>[], precision = 5): string {
  return parts
    .filter((p) => p.length >= 2)
    .map((p) => encodePolyline(p, precision))
    .join(POLYLINE_PART_SEPARATOR);
}

function decodeOnePolyline(str: string, precision: number): LatLon[] {
  const factor = 10 ** precision;
  const out: LatLon[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const len = str.length;
  while (index < len) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < len);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < len);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

/** Distance in meters from a point to the closest point of a path (planar approximation, fine below ~100 km). */
export function distanceToPath(lat: number, lon: number, path: ArrayLike<LatLon>): number {
  if (!path.length) return Infinity;
  const ky = EARTH_RADIUS_M * RAD;
  const kx = ky * Math.cos(lat * RAD);
  const px = lon * kx;
  const py = lat * ky;
  let best = Infinity;
  for (let i = 0; i < path.length; i++) {
    const a = path[i]!;
    const b = path[Math.min(i + 1, path.length - 1)]!;
    const d = segDist2(px, py, a[1] * kx, a[0] * ky, b[1] * kx, b[0] * ky);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}
