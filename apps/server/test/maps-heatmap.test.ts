import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MapsHeatmapResponse, PrivacyZone } from '@cadence/shared';
import { updateSettings } from '../src/core/settings';
import { decodePolyline, haversine, type LatLon } from '../src/lib/geo';
import { trimPrivacyZones } from '../src/features/maps/heatmap';
import { VIENNA, insertWorkout, line, makeApp, trackAlong, type TestApp } from './maps-fixtures';

describe('trimPrivacyZones', () => {
  const home: PrivacyZone = { lat: 48.2, lon: 16.4, radiusM: 300 };
  // a straight line heading east from home: points every ~100 m
  const path: LatLon[] = Array.from({ length: 31 }, (_, i): LatLon => [48.2, 16.4 + i * 0.00135]);

  it('removes the start and end while they are inside a zone, never the middle', () => {
    const out = trimPrivacyZones(path, [home]);
    expect(out.length).toBeLessThan(path.length);
    expect(haversine(out[0]![0], out[0]![1], home.lat, home.lon)).toBeGreaterThan(300);
    expect(out[out.length - 1]).toEqual(path[path.length - 1]); // far end is untouched
    // a zone in the middle of the route is ignored (only the ends are private)
    const mid: PrivacyZone = { lat: 48.2, lon: 16.4 + 15 * 0.00135, radiusM: 150 };
    expect(trimPrivacyZones(path, [mid])).toEqual(path);
  });

  it('trims both ends of a loop and drops routes that stay inside the zone', () => {
    const loop: LatLon[] = [...path, ...[...path].reverse()];
    const out = trimPrivacyZones(loop, [home]);
    expect(out.length).toBeLessThan(loop.length);
    expect(out.length).toBeGreaterThan(loop.length - 12); // only a few points near each end are dropped
    expect(haversine(out[0]![0], out[0]![1], home.lat, home.lon)).toBeGreaterThan(300);
    expect(haversine(out[out.length - 1]![0], out[out.length - 1]![1], home.lat, home.lon)).toBeGreaterThan(300);
    const tiny: LatLon[] = [
      [48.2, 16.4],
      [48.2001, 16.4001],
    ];
    expect(trimPrivacyZones(tiny, [home])).toEqual([]);
    expect(trimPrivacyZones(path, [])).toBe(path);
  });
});

describe('GET /api/maps/heatmap', () => {
  let ctx: TestApp;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    ctx = await makeApp();
    const day = 86_400;
    const base = Date.UTC(2025, 5, 10, 8) / 1000;
    ids.run1 = insertWorkout(ctx.db, {
      sport: 'run',
      startTs: base,
      track: trackAlong(line(VIENNA, 3000), { speed: 3 }),
    });
    ids.run2 = insertWorkout(ctx.db, {
      sport: 'run',
      startTs: base + 400 * day,
      track: trackAlong(line(VIENNA, 4000, 0), { speed: 3 }),
    });
    ids.ride = insertWorkout(ctx.db, {
      sport: 'ride',
      startTs: base + 10 * day,
      track: trackAlong(line(VIENNA, 9000, 45), { speed: 8 }),
    });
    ids.hidden = insertWorkout(ctx.db, {
      sport: 'run',
      startTs: base + 20 * day,
      hidden: true,
      track: trackAlong(line(VIENNA, 2000), { speed: 3 }),
    });
    ids.noRoute = insertWorkout(ctx.db, { sport: 'strength', startTs: base + 30 * day, track: null });
  }, 60_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const get = async (url: string) => {
    const res = await ctx.app.inject({ url });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<MapsHeatmapResponse>();
  };

  it('lists visible routes chronologically with facets and bounds', async () => {
    const r = await get('/api/maps/heatmap');
    expect(r.items.map((i) => i.id)).toEqual([ids.run1, ids.ride, ids.run2]);
    expect(r.items[0]!.polyline.length).toBeGreaterThan(5);
    expect(decodePolyline(r.items[0]!.polyline)[0]![0]).toBeCloseTo(VIENNA[0], 4);
    expect(r.facets.sports.map((s) => s.sport).sort()).toEqual(['ride', 'run']);
    expect(r.facets.sports.find((s) => s.sport === 'run')!.count).toBe(2);
    expect(r.facets.years.map((y) => y.year)).toEqual([2025, 2026]);
    expect(r.bounds![1]).toBeLessThanOrEqual(VIENNA[0]);
    expect(r.totalDistanceM).toBeGreaterThan(15_000);
    expect(r.privacyApplied).toBe(false);
  });

  it('filters by sport and by local day range, but keeps unfiltered facets', async () => {
    const runs = await get('/api/maps/heatmap?sport=run');
    expect(runs.items.map((i) => i.id)).toEqual([ids.run1, ids.run2]);
    expect(runs.facets.sports.length).toBe(2);
    const y2025 = await get('/api/maps/heatmap?fromDay=2025-01-01&toDay=2025-12-31');
    expect(y2025.items.map((i) => i.id)).toEqual([ids.run1, ids.ride]);
    const none = await get('/api/maps/heatmap?sport=swim');
    expect(none.items).toEqual([]);
    expect(none.bounds).toBeNull();
    expect((await ctx.app.inject({ url: '/api/maps/heatmap?fromDay=yesterday' })).statusCode).toBe(400);
  });

  it('hides the start of routes inside privacy zones', async () => {
    updateSettings(ctx.db, 1, { privacyZones: [{ lat: VIENNA[0], lon: VIENNA[1], radiusM: 500 }] });
    const r = await get('/api/maps/heatmap?sport=ride');
    expect(r.privacyApplied).toBe(true);
    const first = decodePolyline(r.items[0]!.polyline)[0]!;
    expect(haversine(first[0], first[1], VIENNA[0], VIENNA[1])).toBeGreaterThan(500);
    updateSettings(ctx.db, 1, { privacyZones: [] });
  });
});
