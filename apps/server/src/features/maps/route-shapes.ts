/**
 * Route shapes: a compact signature of a GPS track, the "same course?" test between two signatures and the
 * greedy clustering that groups workouts into routes. Pure functions (no database), unit tested.
 *
 * A signature is the track resampled to SIG_POINTS positions at equal fractions of its length. Two workouts follow
 * the same route when they start and end within ROUTE_RADIUS_M of each other, are about equally long and their
 * resampled paths stay close (the allowed deviation grows with the length). A reversed direction fails the
 * point-by-point comparison (unless the route is an out-and-back, which is its own reverse) and therefore forms a
 * separate route.
 */
import { haversine } from '../../lib/geo';

export const SIG_POINTS = 50;
/** Start and end of two workouts must be this close to belong to the same route. */
export const ROUTE_RADIUS_M = 200;
/** Allowed length difference (fraction of the longer one). */
export const LENGTH_TOLERANCE = 0.1;
/** Tracks shorter than this do not form routes. */
export const MIN_ROUTE_M = 300;
/** Sample shift (± points) allowed when comparing two paths – absorbs small detours and length differences. */
const WINDOW = 2;

export type RouteKind = 'loop' | 'out_and_back' | 'point_to_point';

export interface RouteSignature {
  lengthM: number;
  /** lat0, lon0, lat1, lon1, … (2 × SIG_POINTS numbers) */
  pts: Float64Array;
}

/**
 * Resample a track to `n` points at equal fractions of its length. `dist` is the cumulative distance (m) per fix; when
 * omitted it is computed from the coordinates. Returns null for tracks that are too short.
 */
export function makeSignature(
  lat: ArrayLike<number>,
  lon: ArrayLike<number>,
  dist?: ArrayLike<number>,
  n = SIG_POINTS,
): RouteSignature | null {
  const m = Math.min(lat.length, lon.length);
  if (m < 2) return null;
  const cum = new Float64Array(m);
  for (let i = 1; i < m; i++) {
    cum[i] =
      dist && dist.length >= m ? dist[i]! : cum[i - 1]! + haversine(lat[i - 1]!, lon[i - 1]!, lat[i]!, lon[i]!);
  }
  // a stored distance stream can contain equal neighbours; keep it monotone
  for (let i = 1; i < m; i++) if (cum[i]! < cum[i - 1]!) cum[i] = cum[i - 1]!;
  const total = cum[m - 1]!;
  if (!(total >= MIN_ROUTE_M)) return null;
  const pts = new Float64Array(2 * n);
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    while (j < m - 2 && cum[j + 1]! < target) j++;
    const seg = cum[j + 1]! - cum[j]!;
    const f = seg > 0 ? Math.min(1, Math.max(0, (target - cum[j]!) / seg)) : 0;
    pts[2 * k] = lat[j]! + (lat[j + 1]! - lat[j]!) * f;
    pts[2 * k + 1] = lon[j]! + (lon[j + 1]! - lon[j]!) * f;
  }
  return { lengthM: total, pts };
}

const M_PER_DEG = 111_195;

/** Distance in meters between point i of `a` and point j of `b` (equirectangular, fine below a few km). */
function d(a: Float64Array, i: number, b: Float64Array, j: number): number {
  const dLat = (a[2 * i]! - b[2 * j]!) * M_PER_DEG;
  const dLon = (a[2 * i + 1]! - b[2 * j + 1]!) * M_PER_DEG * Math.cos((a[2 * i]! * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

export interface Similarity {
  match: boolean;
  /** Mean / max deviation in meters (when the cheap tests passed). */
  mean?: number;
  max?: number;
  reason?: 'length' | 'start' | 'end' | 'shape';
}

/** Mean deviation allowed for a route of this length (m). */
export const shapeTolerance = (lengthM: number): number => Math.min(90, Math.max(25, 0.005 * lengthM));

/** One-sided deviation: every point of `a` against the nearest of the ±WINDOW points of `b`. */
function oneSided(a: Float64Array, b: Float64Array, n: number): { mean: number; max: number } {
  let sum = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (let j = Math.max(0, i - WINDOW); j <= Math.min(n - 1, i + WINDOW); j++) {
      const v = d(a, i, b, j);
      if (v < best) best = v;
    }
    sum += best;
    if (best > max) max = best;
  }
  return { mean: sum / n, max };
}

/** Do two signatures describe the same course in the same direction? */
export function compareSignatures(a: RouteSignature, b: RouteSignature): Similarity {
  const n = a.pts.length / 2;
  if (n !== b.pts.length / 2) return { match: false, reason: 'shape' };
  const longer = Math.max(a.lengthM, b.lengthM);
  if (Math.abs(a.lengthM - b.lengthM) / longer > LENGTH_TOLERANCE) return { match: false, reason: 'length' };
  if (d(a.pts, 0, b.pts, 0) > ROUTE_RADIUS_M) return { match: false, reason: 'start' };
  if (d(a.pts, n - 1, b.pts, n - 1) > ROUTE_RADIUS_M) return { match: false, reason: 'end' };
  const ab = oneSided(a.pts, b.pts, n);
  const ba = oneSided(b.pts, a.pts, n);
  const mean = Math.max(ab.mean, ba.mean);
  const max = Math.max(ab.max, ba.max);
  const tol = shapeTolerance(longer);
  const match = mean <= tol && max <= 3 * tol;
  return { match, mean, max, ...(match ? {} : { reason: 'shape' as const }) };
}

/** Loop (back near the start), out-and-back (its second half retraces the first) or point-to-point. */
export function routeKind(sig: RouteSignature): RouteKind {
  const n = sig.pts.length / 2;
  const closed = d(sig.pts, 0, sig.pts, n - 1) <= ROUTE_RADIUS_M;
  if (!closed) return 'point_to_point';
  // palindromic path: point i ≈ point n-1-i
  let sum = 0;
  for (let i = 0; i < n; i++) sum += d(sig.pts, i, sig.pts, n - 1 - i);
  const tol = Math.min(120, Math.max(40, 0.012 * sig.lengthM));
  return sum / n <= tol ? 'out_and_back' : 'loop';
}

// ---------------------------------------------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------------------------------------------

export interface RouteRep {
  /** Existing route id (> 0). */
  id: number;
  sport: string;
  sig: RouteSignature;
}

export interface ShapedWorkout {
  id: number;
  sport: string;
  sig: RouteSignature;
}

export interface Clustering {
  /** workout id → route id (existing ids > 0, new routes get ids −1, −2, …). */
  assignment: Map<number, number>;
  /** new route id (< 0) → the workout that founded it (its representative). */
  founders: Map<number, number>;
}

/**
 * Greedy, order dependent clustering: every workout (callers pass them in chronological order) joins the best
 * matching route of the same sport – the one with the smallest mean deviation from its representative – or founds a
 * new route. `existing` are the representatives of routes that already exist (incremental runs).
 */
export function assignRoutes(existing: RouteRep[], workouts: ShapedWorkout[]): Clustering {
  const reps: RouteRep[] = [...existing];
  const assignment = new Map<number, number>();
  const founders = new Map<number, number>();
  let nextNew = -1;
  const bySport = new Map<string, RouteRep[]>();
  const add = (r: RouteRep) => {
    const list = bySport.get(r.sport);
    if (list) list.push(r);
    else bySport.set(r.sport, [r]);
  };
  reps.forEach(add);
  for (const w of workouts) {
    let best: RouteRep | null = null;
    let bestMean = Infinity;
    for (const r of bySport.get(w.sport) ?? []) {
      const s = compareSignatures(w.sig, r.sig);
      if (s.match && s.mean! < bestMean) {
        best = r;
        bestMean = s.mean!;
      }
    }
    if (best) assignment.set(w.id, best.id);
    else {
      const id = nextNew--;
      founders.set(id, w.id);
      assignment.set(w.id, id);
      add({ id, sport: w.sport, sig: w.sig });
    }
  }
  return { assignment, founders };
}

/**
 * Keep route ids (and with them user renames) stable across a full rebuild: every new cluster takes over the old route
 * it shares the most workouts with, biggest clusters first; a route is only taken over once.
 * Returns new route id (< 0) → old route id.
 */
export function matchOldRoutes(
  newAssignment: Map<number, number>,
  oldAssignment: Map<number, number | null>,
  canReuse: (newId: number, oldId: number) => boolean = () => true,
): Map<number, number> {
  const overlap = new Map<number, Map<number, number>>(); // new → (old → shared workouts)
  const size = new Map<number, number>();
  for (const [w, nr] of newAssignment) {
    size.set(nr, (size.get(nr) ?? 0) + 1);
    const old = oldAssignment.get(w);
    if (old == null) continue;
    let m = overlap.get(nr);
    if (!m) overlap.set(nr, (m = new Map()));
    m.set(old, (m.get(old) ?? 0) + 1);
  }
  const claimed = new Set<number>();
  const out = new Map<number, number>();
  const order = [...size.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]).map(([id]) => id);
  for (const nr of order) {
    const cands = [...(overlap.get(nr) ?? [])].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const pick = cands.find(([old]) => !claimed.has(old) && canReuse(nr, old));
    if (pick) {
      claimed.add(pick[0]);
      out.set(nr, pick[0]);
    }
  }
  return out;
}

/** City / region of an IANA time zone id ('Europe/Vienna' → 'Vienna'); null for zones that are no places. */
export function areaFromTimezone(tz: string | null | undefined): string | null {
  if (!tz || /^(Etc|UTC|GMT)/i.test(tz)) return null;
  const last = tz.split('/').pop();
  return last ? last.replace(/_/g, ' ') : null;
}
