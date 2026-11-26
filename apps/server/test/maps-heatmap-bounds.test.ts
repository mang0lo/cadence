import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MapsHeatmapResponse } from '@cadence/shared';
import { updateSettings } from '../src/core/settings';
import { decodePolylineParts, destination, haversine } from '../src/lib/geo';
import { VIENNA, insertWorkout, line, makeApp, trackAlong, type TestApp } from './maps-fixtures';

/** The heatmap's bounds frame exactly the routes it sends: with and without privacy zones. */
describe('GET /api/maps/heatmap bounds', () => {
  let ctx: TestApp;
  const day = 86_400;
  const t0 = Date.UTC(2025, 8, 1, 7) / 1000;

  beforeAll(async () => {
    ctx = await makeApp();
    const tracks = [
      line(VIENNA, 3000, 60),
      line(destination(VIENNA[0], VIENNA[1], 200, 4000), 5000, 300),
      line(destination(VIENNA[0], VIENNA[1], 120, 2000), 2500, 10),
    ];
    tracks.forEach((points, i) =>
      insertWorkout(ctx.db, {
        sport: 'run',
        startTs: t0 + i * day,
        track: trackAlong(points, { speed: 3, noiseM: 4, seed: i + 1 }),
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const heatmap = async () => {
    const res = await ctx.app.inject({ url: '/api/maps/heatmap' });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<MapsHeatmapResponse>();
  };
  /** [minLon, minLat, maxLon, maxLat] of every point the response draws. */
  const extentOf = (r: MapsHeatmapResponse) => {
    const pts = r.items.flatMap((i) => decodePolylineParts(i.polyline).flat());
    return [
      Math.min(...pts.map((p) => p[1])),
      Math.min(...pts.map((p) => p[0])),
      Math.max(...pts.map((p) => p[1])),
      Math.max(...pts.map((p) => p[0])),
    ];
  };
  /** The bounds contain every drawn point and lie within `slackM` of the drawn extent. */
  const expectFrames = (r: MapsHeatmapResponse, slackM: number) => {
    const [minLon, minLat, maxLon, maxLat] = r.bounds!;
    const e = extentOf(r);
    const eps = 1e-9;
    expect(minLon).toBeLessThanOrEqual(e[0]! + eps);
    expect(minLat).toBeLessThanOrEqual(e[1]! + eps);
    expect(maxLon).toBeGreaterThanOrEqual(e[2]! - eps);
    expect(maxLat).toBeGreaterThanOrEqual(e[3]! - eps);
    expect(haversine(minLat, minLon, minLat, e[0]!)).toBeLessThan(slackM);
    expect(haversine(minLat, minLon, e[1]!, minLon)).toBeLessThan(slackM);
    expect(haversine(maxLat, maxLon, maxLat, e[2]!)).toBeLessThan(slackM);
    expect(haversine(maxLat, maxLon, e[3]!, maxLon)).toBeLessThan(slackM);
  };

  it('frames the routes without privacy zones', async () => {
    const r = await heatmap();
    expect(r.items.length).toBe(3);
    // the routes are simplified (5 m) and rounded (~1 m) for drawing
    expectFrames(r, 10);
  });

  it('frames the trimmed routes with a privacy zone', async () => {
    // around the end of the first route, its north-east corner: the trimmed route no longer reaches that far east
    const home = destination(VIENNA[0], VIENNA[1], 60, 3000);
    updateSettings(ctx.db, 1, { privacyZones: [{ lat: home[0], lon: home[1], radiusM: 700 }] });
    try {
      const r = await heatmap();
      expect(r.privacyApplied).toBe(true);
      expect(r.items.length).toBe(3);
      expectFrames(r, 0.5);
      const maxLon = r.bounds![2];
      expect(maxLon).toBeLessThan(home[1]);
      expect(haversine(home[0], home[1], home[0], maxLon)).toBeGreaterThan(500);
    } finally {
      updateSettings(ctx.db, 1, { privacyZones: [] });
    }
  });
});
