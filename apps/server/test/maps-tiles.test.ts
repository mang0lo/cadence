import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MapsExplorerResponse, MapsExplorerSummary } from '@cadence/shared';
import { monthSeries } from '../src/features/maps/explorer';
import {
  TILE_STRIDE,
  coarsen,
  explorerStats,
  interiorTiles,
  keyX,
  keyY,
  lonLatToTile,
  maxCluster,
  maxSquare,
  tileBounds,
  tileCover,
  tileKey,
  tileToLonLat,
} from '../src/features/maps/tiles';
import { VIENNA, insertWorkout, line, makeApp, runMapsSteps, trackAlong, type TestApp } from './maps-fixtures';

/** All tiles of a w × h block with its top-left tile at (x0, y0). */
const block = (x0: number, y0: number, w: number, h: number): number[] => {
  const out: number[] = [];
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.push(tileKey(x, y));
  return out;
};

describe('tile math', () => {
  it('maps coordinates to slippy tiles and back', () => {
    expect(lonLatToTile(0, 0, 1)).toEqual([1, 1]);
    expect(lonLatToTile(0, -180, 3)[0]).toBe(0);
    const [x, y] = lonLatToTile(VIENNA[0], VIENNA[1], 14);
    expect(Math.floor(x)).toBe(8937);
    expect(Math.floor(y)).toBe(5681);
    const [lon, lat] = tileToLonLat(x, y, 14);
    expect(lon).toBeCloseTo(VIENNA[1], 9);
    expect(lat).toBeCloseTo(VIENNA[0], 9);
    const [minLon, minLat, maxLon, maxLat] = tileBounds(8937, 5681, 14);
    expect(VIENNA[1]).toBeGreaterThan(minLon);
    expect(VIENNA[1]).toBeLessThan(maxLon);
    expect(VIENNA[0]).toBeGreaterThan(minLat);
    expect(VIENNA[0]).toBeLessThan(maxLat);
    // a 2 × 3 block spans twice the width and three times the height
    const b = tileBounds(8937, 5681, 14, 2, 3);
    expect(b[2] - b[0]).toBeCloseTo((maxLon - minLon) * 2, 9);
    expect(b[3]).toBe(maxLat);
  });

  it('packs tile keys exactly', () => {
    const k = tileKey(131071, 98765);
    expect(keyX(k)).toBe(131071);
    expect(keyY(k)).toBe(98765);
    expect(k).toBe(98765 * TILE_STRIDE + 131071);
    expect(Number.isSafeInteger(tileKey(2 ** 17, 2 ** 17))).toBe(true);
  });
});

describe('tileCover', () => {
  /** Lat/lon of fractional tile coordinates. */
  const at = (u: number, v: number, z = 14): [number, number] => {
    const [lon, lat] = tileToLonLat(u, v, z);
    return [lat, lon];
  };

  it('returns the tile of a single fix and ignores invalid ones', () => {
    const p = at(100.5, 200.5);
    const cover = tileCover([p[0], NaN], [p[1], 16], 14);
    expect([...cover]).toEqual([tileKey(100, 200)]);
    expect(tileCover([], [], 14).size).toBe(0);
  });

  it('fills the tiles between two fixes that are several tiles apart (gap interpolation)', () => {
    // straight east: four tiles apart in the same row
    const a = at(100.5, 200.5);
    const b = at(104.5, 200.5);
    const cover = tileCover([a[0], b[0]], [a[1], b[1]], 14);
    expect([...cover].sort((p, q) => p - q)).toEqual([100, 101, 102, 103, 104].map((x) => tileKey(x, 200)));
    // straight south
    const c = at(100.5, 203.5);
    const south = tileCover([a[0], c[0]], [a[1], c[1]], 14);
    expect([...south].sort((p, q) => p - q)).toEqual([200, 201, 202, 203].map((y) => tileKey(100, y)));
  });

  it('walks diagonals 4-connected and is symmetric', () => {
    const a = at(100.5, 200.5);
    const b = at(103.5, 202.5);
    const fwd = tileCover([a[0], b[0]], [a[1], b[1]], 14);
    const back = tileCover([b[0], a[0]], [b[1], a[1]], 14);
    // |Δx| + |Δy| + 1 cells for a straight line that never hits a corner exactly
    expect(fwd.size).toBe(3 + 2 + 1);
    expect([...fwd].sort()).toEqual([...back].sort());
    expect(fwd.has(tileKey(100, 200))).toBe(true);
    expect(fwd.has(tileKey(103, 202))).toBe(true);
    // the walk is connected: every tile touches another tile of the set
    for (const k of fwd) {
      if (k === tileKey(100, 200)) continue;
      const touching = [k - 1, k + 1, k - TILE_STRIDE, k + TILE_STRIDE].some((n) => fwd.has(n));
      expect(touching).toBe(true);
    }
  });

  it('does not bridge huge gaps (flight, paused recording)', () => {
    const a = at(8936.5, 5686.5); // Vienna
    const b = at(8976.5, 5686.5); // 40 tiles east ≈ 65 km
    expect(tileCover([a[0], b[0]], [a[1], b[1]], 14).size).toBe(2);
    expect(tileCover([a[0], b[0]], [a[1], b[1]], 14, { maxGapM: 100_000 }).size).toBe(41);
  });

  it('covers a real 5 km track once per tile', () => {
    const tr = trackAlong(line(VIENNA, 5000), { speed: 3 });
    const z14 = tileCover(tr.lat, tr.lon, 14);
    const z17 = tileCover(tr.lat, tr.lon, 17);
    expect(z14.size).toBeGreaterThanOrEqual(3);
    expect(z14.size).toBeLessThanOrEqual(5);
    expect(z17.size).toBeGreaterThanOrEqual(20);
    // the coarse tiles are exactly the parents of the fine ones
    expect([...coarsen(z17, 3)].sort()).toEqual([...z14].sort());
  });
});

describe('explorer statistics', () => {
  it('finds the largest square', () => {
    expect(maxSquare(new Set())).toBeNull();
    expect(maxSquare(new Set([tileKey(5, 5)]))).toEqual({ size: 1, x: 5, y: 5 });
    // 4 × 3 block + a stray tile + a separate 2 × 2 block
    const tiles = new Set([...block(10, 20, 4, 3), tileKey(30, 30), ...block(50, 50, 2, 2)]);
    expect(maxSquare(tiles)).toEqual({ size: 3, x: 10, y: 20 });
    // L shape never forms a 2 × 2
    const l = new Set([...block(0, 0, 5, 1), ...block(0, 0, 1, 5)]);
    expect(maxSquare(l)!.size).toBe(1);
    // a hole breaks the square
    const holey = new Set(block(0, 0, 3, 3));
    holey.delete(tileKey(1, 1));
    expect(maxSquare(holey)!.size).toBe(1);
    holey.add(tileKey(1, 1));
    expect(maxSquare(holey)).toEqual({ size: 3, x: 0, y: 0 });
  });

  it('finds interior tiles and the largest cluster', () => {
    const big = block(0, 0, 5, 5);
    const small = block(20, 20, 3, 3);
    const tiles = new Set([...big, ...small]);
    const interior = interiorTiles(tiles);
    expect(interior.size).toBe(9 + 1);
    expect(interior.has(tileKey(2, 2))).toBe(true);
    expect(interior.has(tileKey(0, 0))).toBe(false);
    const cluster = maxCluster(interior);
    expect(cluster.size).toBe(9);
    expect(cluster.keys).toContain(tileKey(1, 1));
    expect(cluster.keys).not.toContain(tileKey(21, 21));
    const stats = explorerStats(tiles);
    expect(stats).toMatchObject({ tiles: 25 + 9, maxCluster: { size: 9 } });
    expect(stats.maxSquare).toEqual({ size: 5, x: 0, y: 0 });
  });

  it('does not connect interior tiles that only touch diagonally', () => {
    // two plus-shaped crosses whose centers are diagonal neighbours
    const plus = (cx: number, cy: number) => [
      tileKey(cx, cy),
      tileKey(cx - 1, cy),
      tileKey(cx + 1, cy),
      tileKey(cx, cy - 1),
      tileKey(cx, cy + 1),
    ];
    const tiles = new Set([...plus(10, 10), ...plus(11, 11)]);
    const interior = interiorTiles(tiles);
    // (10,10) has all 4 neighbours; (11,11) too; (10,11)/(11,10) are in both pluses' arms
    expect(interior.has(tileKey(10, 10))).toBe(true);
    expect(interior.has(tileKey(11, 11))).toBe(true);
    expect(maxCluster(new Set([tileKey(10, 10), tileKey(11, 11)])).size).toBe(1);
    expect(maxCluster(new Set()).size).toBe(0);
  });

  it('builds a gapless month series with running totals', () => {
    const per = new Map([
      ['2025-11', 4],
      ['2026-02', 2],
    ]);
    const s = monthSeries(per, '2026-03');
    expect(s.map((m) => m.month)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02', '2026-03']);
    expect(s.map((m) => m.newTiles)).toEqual([4, 0, 0, 2, 0]);
    expect(s.map((m) => m.total)).toEqual([4, 4, 4, 6, 6]);
    expect(monthSeries(new Map(), '2026-03')).toEqual([]);
    // never ends before the last data month even when "now" is older
    expect(monthSeries(new Map([['2026-05', 1]]), '2026-03').map((m) => m.month)).toEqual(['2026-05']);
  });
});

describe('explorer derive step + API', () => {
  let ctx: TestApp;
  const ids: Record<string, number> = {};
  const day = 86_400;
  const t0 = Date.UTC(2026, 0, 5, 8) / 1000;

  beforeAll(async () => {
    ctx = await makeApp();
    // 1: run east 5 km (first visit), 2: ride along the same road further (second visit + new tiles),
    // 3: hidden run far south, 4: run in another country, 5: strength (no route)
    ids.run = insertWorkout(ctx.db, { sport: 'run', startTs: t0, track: trackAlong(line(VIENNA, 5000), { speed: 3 }) });
    ids.ride = insertWorkout(ctx.db, {
      sport: 'ride',
      startTs: t0 + 40 * day,
      track: trackAlong(line(VIENNA, 12_000), { speed: 8 }),
    });
    ids.hidden = insertWorkout(ctx.db, {
      sport: 'run',
      startTs: t0 + 50 * day,
      hidden: true,
      track: trackAlong(line(VIENNA, 6000, 180), { speed: 3 }),
    });
    ids.abroad = insertWorkout(ctx.db, {
      sport: 'run',
      startTs: t0 + 60 * day,
      tzMin: -300,
      track: trackAlong(line([40.7685, -73.9819], 3000, 0), { speed: 3 }),
    });
    ids.strength = insertWorkout(ctx.db, { sport: 'strength', startTs: t0 + 70 * day });
    await runMapsSteps(ctx.db, 'all');
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const get = async <T>(url: string) => {
    const res = await ctx.app.inject({ url });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<T>();
  };

  it('stores the tiles of every routed workout and nothing else', async () => {
    const rows = ctx.db
      .prepare('SELECT workout_id, z, COUNT(*) AS n FROM maps_workout_tiles GROUP BY workout_id, z ORDER BY workout_id, z')
      .all() as { workout_id: number; z: number; n: number }[];
    const byWorkout = new Set(rows.map((r) => r.workout_id));
    expect(byWorkout).toEqual(new Set([ids.run, ids.ride, ids.hidden, ids.abroad]));
    expect(rows.every((r) => r.n > 0)).toBe(true);
  });

  it('aggregates first visit, visits and statistics at zoom 14', async () => {
    const r = await get<MapsExplorerResponse>('/api/maps/explorer');
    expect(r.zoom).toBe(14);
    expect(r.compact).toBeNull();
    // hidden workouts do not count: tiles of run + ride + abroad
    const expected = new Set<number>();
    for (const w of [ids.run, ids.ride, ids.abroad]) {
      const rows = ctx.db
        .prepare('SELECT x, y FROM maps_workout_tiles WHERE workout_id = ? AND z = 14')
        .all(w) as { x: number; y: number }[];
      for (const t of rows) expected.add(tileKey(t.x, t.y));
    }
    expect(r.tiles.length).toBe(expected.size);
    expect(r.totals.tiles).toBe(expected.size);
    expect(r.totals.workouts).toBe(3);
    // the ride re-visits the tiles of the run → they keep the run as first workout and count 2 visits
    const [ux, uy] = lonLatToTile(VIENNA[0], VIENNA[1], 14);
    const start = r.tiles.find((t) => t.x === Math.floor(ux) && t.y === Math.floor(uy))!;
    expect(start.workoutId).toBe(ids.run);
    expect(start.visits).toBe(2);
    expect(start.firstTs).toBe(t0);
    expect(start.tzMin).toBe(60);
    const onlyRide = r.tiles.filter((t) => t.workoutId === ids.ride);
    expect(onlyRide.length).toBeGreaterThan(0);
    expect(onlyRide.every((t) => t.visits === 1)).toBe(true);
    // one narrow strip: no square beyond 1 and no interior tiles
    expect(r.totals.maxSquare).toBe(1);
    expect(r.totals.maxCluster).toBe(0);
    expect(r.maxSquare!.size).toBe(1);
    // months: the first visit month of each tile
    expect(r.months[0]).toMatchObject({ month: '2026-01' });
    expect(r.months.reduce((s, m) => s + m.newTiles, 0)).toBe(expected.size);
    expect(r.months[r.months.length - 1]!.total).toBe(expected.size);
    expect(r.bounds![0]).toBeLessThan(-70); // New York is part of the bounds
    expect(r.sports.map((s) => s.sport).sort()).toEqual(['ride', 'run']);
  });

  it('filters by sport and delivers compact tiles at zoom 17', async () => {
    const rides = await get<MapsExplorerResponse>('/api/maps/explorer?sport=ride');
    expect(rides.totals.workouts).toBe(1);
    expect(rides.tiles.every((t) => t.workoutId === ids.ride)).toBe(true);
    const z17 = await get<MapsExplorerResponse>('/api/maps/explorer?zoom=17');
    expect(z17.tiles).toEqual([]);
    expect(z17.compact!.x.length).toBe(z17.totals.tiles);
    expect(z17.compact!.y.length).toBe(z17.totals.tiles);
    expect(z17.totals.tiles).toBeGreaterThan(40);
    expect((await ctx.app.inject({ url: '/api/maps/explorer?zoom=15' })).statusCode).toBe(400);
  });

  it('follows hide / unhide without a rebuild and reports the dashboard summary', async () => {
    const before = await get<MapsExplorerSummary>('/api/maps/explorer/summary');
    expect(before.tiles).toBeGreaterThan(5);
    ctx.db.prepare('UPDATE workouts SET hidden = 0, updated_at = updated_at + 1 WHERE id = ?').run(ids.hidden);
    const after = await get<MapsExplorerSummary>('/api/maps/explorer/summary');
    expect(after.tiles).toBeGreaterThan(before.tiles);
    expect(after.workouts).toBe(4);
    // a workout from right now somewhere new counts as "new this month"
    const now = Math.floor(Date.now() / 1000);
    const fresh = insertWorkout(ctx.db, {
      sport: 'run',
      startTs: now - 600,
      tzMin: 0,
      track: trackAlong(line([35.0, 139.0], 3000, 0), { speed: 3 }),
    });
    await runMapsSteps(ctx.db, [fresh]);
    const summary = await get<MapsExplorerSummary>('/api/maps/explorer/summary');
    expect(summary.newThisMonth).toBeGreaterThanOrEqual(2);
    expect(summary.newThisMonth + summary.newLastMonth).toBeLessThanOrEqual(summary.tiles);
    expect(summary.workouts).toBe(5);
  });

  it('recomputes a single workout and drops its tiles when the route is gone', async () => {
    ctx.db.prepare('UPDATE workouts SET has_route = 0 WHERE id = ?').run(ids.abroad);
    ctx.db.prepare('DELETE FROM workout_streams WHERE workout_id = ?').run(ids.abroad);
    await runMapsSteps(ctx.db, [ids.abroad]);
    const n = ctx.db.prepare('SELECT COUNT(*) AS n FROM maps_workout_tiles WHERE workout_id = ?').get(ids.abroad) as {
      n: number;
    };
    expect(n.n).toBe(0);
    const r = await get<MapsExplorerResponse>('/api/maps/explorer');
    expect(r.bounds![0]).toBeGreaterThan(0); // New York left
  });
});
