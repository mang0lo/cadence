/**
 * Slippy-map tile geometry for the Explorer: which tiles a GPS track passed through (gaps interpolated), and the
 * "explorer" statistics of a set of visited tiles (max square, max cluster).
 *
 * A tile is identified by one number: `y * TILE_STRIDE + x` (exact in a double for every zoom ≤ 20).
 * The basic tile math lives in @cadence/shared (the Explorer page uses it too) and is re-exported here.
 */
import { TILE_STRIDE, keyX, keyY, lonLatToTile, tileKey } from '@cadence/shared';
import { haversine } from '../../lib/geo';

export { TILE_STRIDE, keyX, keyY, lonLatToTile, tileBounds, tileKey, tileToLonLat } from '@cadence/shared';

export interface CoverOptions {
  /** Gaps between two consecutive fixes longer than this are not bridged (e.g. a flight, a paused recording). */
  maxGapM?: number;
  /** Indices where a new part of the track starts (WorkoutStreams.breaks): never bridged. */
  breaks?: ArrayLike<number>;
}

/**
 * Tiles (as keys) a track passed through at zoom `z`. Consecutive fixes in different tiles are joined by a straight
 * line and every tile along it is added (4-connected grid walk), so a gap in the recording (tunnel, signal loss) or a
 * sparse polyline never leaves holes.
 */
export function tileCover(
  lat: ArrayLike<number>,
  lon: ArrayLike<number>,
  z: number,
  opts: CoverOptions = {},
): Set<number> {
  const maxGapM = opts.maxGapM ?? 10_000;
  const breaks = new Set(Array.from(opts.breaks ?? []));
  const out = new Set<number>();
  const n = Math.min(lat.length, lon.length);
  const size = 2 ** z;
  let pu = NaN;
  let pv = NaN;
  let pLat = NaN;
  let pLon = NaN;
  for (let i = 0; i < n; i++) {
    const la = lat[i]!;
    const lo = lon[i]!;
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    const [u, v] = lonLatToTile(la, lo, z);
    const cx = Math.floor(u);
    const cy = Math.floor(v);
    out.add(tileKey(wrapX(cx, size), cy));
    if (pu === pu && !breaks.has(i) && (Math.floor(pu) !== cx || Math.floor(pv) !== cy)) {
      // across the 180th meridian the short way leaves the grid on one side and comes back on the other
      const du = u - pu;
      const to = du > size / 2 ? u - size : du < -size / 2 ? u + size : u;
      if (haversine(pLat, pLon, la, lo) <= maxGapM) walk(out, pu, pv, to, v, size);
    }
    pu = u;
    pv = v;
    pLat = la;
    pLon = lo;
  }
  return out;
}

/** Tile column `x` wrapped into the grid of `size` columns (x = size is the meridian 180°, i.e. column 0). */
const wrapX = (x: number, size: number): number => ((x % size) + size) % size;

/**
 * Add every tile on the straight line (u0,v0) → (u1,v1) (fractional tile coordinates, u may leave the grid of `size`
 * columns across the 180th meridian), 4-connected.
 */
function walk(out: Set<number>, u0: number, v0: number, u1: number, v1: number, size: number): void {
  let x = Math.floor(u0);
  let y = Math.floor(v0);
  const ex = Math.floor(u1);
  const ey = Math.floor(v1);
  const dx = u1 - u0;
  const dy = v1 - v0;
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  // parametric distance to the next vertical / horizontal grid line, and between successive ones
  let tx = dx === 0 ? Infinity : (dx > 0 ? x + 1 - u0 : u0 - x) / Math.abs(dx);
  let ty = dy === 0 ? Infinity : (dy > 0 ? y + 1 - v0 : v0 - y) / Math.abs(dy);
  const ddx = dx === 0 ? Infinity : 1 / Math.abs(dx);
  const ddy = dy === 0 ? Infinity : 1 / Math.abs(dy);
  // exactly |Δx| + |Δy| steps are needed; the counters make rounding at grid lines harmless
  let stepsX = Math.abs(ex - x);
  let stepsY = Math.abs(ey - y);
  while (stepsX > 0 || stepsY > 0) {
    if (stepsY === 0 || (stepsX > 0 && tx < ty)) {
      x += sx;
      tx += ddx;
      stepsX--;
    } else {
      y += sy;
      ty += ddy;
      stepsY--;
    }
    out.add(tileKey(wrapX(x, size), y));
  }
}

/** The tiles `zoomDiff` zoom levels lower (bigger) that contain the given tiles. */
export function coarsen(tiles: Iterable<number>, zoomDiff: number): Set<number> {
  const out = new Set<number>();
  const f = 2 ** zoomDiff;
  for (const k of tiles) out.add(tileKey(Math.floor(keyX(k) / f), Math.floor(keyY(k) / f)));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Explorer statistics
// ---------------------------------------------------------------------------------------------------------------

export interface MaxSquare {
  /** Edge length in tiles (the square holds size × size visited tiles). */
  size: number;
  /** Top-left (north-west) tile. */
  x: number;
  y: number;
}

/** Largest n × n block of visited tiles (dynamic programming over the visited tiles only). */
export function maxSquare(tiles: Set<number> | number[]): MaxSquare | null {
  const set = tiles instanceof Set ? tiles : new Set(tiles);
  if (!set.size) return null;
  // row-major order guarantees the three predecessors are processed first
  const sorted = [...set].sort((a, b) => a - b);
  const dp = new Map<number, number>();
  let best: MaxSquare = { size: 0, x: 0, y: 0 };
  for (const k of sorted) {
    const left = dp.get(k - 1) ?? 0;
    const up = dp.get(k - TILE_STRIDE) ?? 0;
    const diag = dp.get(k - TILE_STRIDE - 1) ?? 0;
    const size = 1 + Math.min(left, up, diag);
    dp.set(k, size);
    if (size > best.size) best = { size, x: keyX(k) - size + 1, y: keyY(k) - size + 1 };
  }
  return best;
}

/** Visited tiles whose four neighbours (N, E, S, W) are visited too. */
export function interiorTiles(tiles: Set<number>): Set<number> {
  const out = new Set<number>();
  for (const k of tiles) {
    if (tiles.has(k - 1) && tiles.has(k + 1) && tiles.has(k - TILE_STRIDE) && tiles.has(k + TILE_STRIDE))
      out.add(k);
  }
  return out;
}

export interface MaxCluster {
  /** Tiles in the largest group of connected interior tiles. */
  size: number;
  keys: number[];
}

/**
 * Largest cluster: the biggest 4-connected group of interior tiles (visited tiles that have visited tiles on all
 * four sides). Ties are broken by the first tile in row-major order.
 */
export function maxCluster(interior: Set<number>): MaxCluster {
  const seen = new Set<number>();
  let best: number[] = [];
  const sorted = [...interior].sort((a, b) => a - b);
  for (const start of sorted) {
    if (seen.has(start)) continue;
    const group: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const k = stack.pop()!;
      group.push(k);
      for (const nb of [k - 1, k + 1, k - TILE_STRIDE, k + TILE_STRIDE]) {
        if (interior.has(nb) && !seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    if (group.length > best.length) best = group;
  }
  return { size: best.length, keys: best };
}

export interface ExplorerStats {
  tiles: number;
  maxSquare: MaxSquare | null;
  interior: Set<number>;
  maxCluster: MaxCluster;
}

export function explorerStats(tiles: Set<number>): ExplorerStats {
  const interior = interiorTiles(tiles);
  return { tiles: tiles.size, maxSquare: maxSquare(tiles), interior, maxCluster: maxCluster(interior) };
}
