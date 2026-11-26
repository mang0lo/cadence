/**
 * Heatmap and explorer layer helpers (apps/web/src/features/maps/lib/heatmapLayers.ts, explorerLayers.ts) against a
 * fake map with a loaded basemap style.
 */
import { describe, expect, it } from 'vitest';
import { ID, ensureExplorerLayers, explorerColors, visitSteps } from '@/features/maps/lib/explorerLayers';
import { LAYER, densityPoints, ensureHeatLayers, heatPalette, type HeatLine } from '@/features/maps/lib/heatmapLayers';
import { FakeLayerMap } from './fake-map';

/** A basemap: background, area fills, roads, then labels. */
const BASE: [string, string][] = [
  ['background', 'background'],
  ['water', 'fill'],
  ['roads', 'line'],
  ['place-labels', 'symbol'],
  ['poi', 'symbol'],
];

describe('ensureHeatLayers', () => {
  it('puts the heat layers below the basemap labels without serializing the style', () => {
    const m = new FakeLayerMap(BASE);
    ensureHeatLayers(m.map, heatPalette('hot', true));
    expect(m.calls).not.toContain('getStyle');
    expect(m.order.slice(0, 3)).toEqual(['background', 'water', 'roads']);
    expect(m.order.slice(-2)).toEqual(['place-labels', 'poi']);
    expect(m.added('hm-')).toEqual([
      LAYER.density,
      LAYER.glow,
      LAYER.mid,
      LAYER.core,
      LAYER.hot,
      LAYER.headGlow,
      LAYER.head,
      LAYER.hit,
    ]);
  });

  it('does nothing once the layers exist (the time-lapse calls it on every frame)', () => {
    const m = new FakeLayerMap(BASE);
    ensureHeatLayers(m.map, heatPalette('hot', true));
    m.resetCalls();
    ensureHeatLayers(m.map, heatPalette('blue', false));
    expect(m.calls).toEqual([]);
  });

  it('works on a basemap without labels (satellite imagery)', () => {
    const m = new FakeLayerMap([['imagery', 'raster']]);
    ensureHeatLayers(m.map, heatPalette('hot', true));
    expect(m.order[0]).toBe('imagery');
    expect(m.order[m.order.length - 1]).toBe(LAYER.hit);
  });
});

describe('ensureExplorerLayers', () => {
  const colors = explorerColors('visits', false, '#e8590c', '#2a78d6');

  it('puts the tile layers below the basemap labels without serializing the style', () => {
    const m = new FakeLayerMap(BASE);
    ensureExplorerLayers(m.map, colors, visitSteps(10));
    expect(m.calls).not.toContain('getStyle');
    expect(m.order.slice(-2)).toEqual(['place-labels', 'poi']);
    expect(m.added('ex')).toEqual([ID.fill, ID.line, ID.cluster, ID.detailFill, ID.detailLine, ID.next, ID.square]);
  });

  it('does nothing once the layers exist (it runs on every pan at zoom 17)', () => {
    const m = new FakeLayerMap(BASE);
    ensureExplorerLayers(m.map, colors, visitSteps(10));
    m.resetCalls();
    ensureExplorerLayers(m.map, colors, visitSteps(10));
    expect(m.calls).toEqual([]);
  });
});

describe('densityPoints', () => {
  const M_PER_DEG = 111_320;
  /** A heat line through `coords` (planar lengths as toHeatLines computes them). */
  const line = (i: number, coords: [number, number][]): HeatLine => {
    const k = Math.cos((coords[0]![1] * Math.PI) / 180);
    const cum = [0];
    for (let j = 1; j < coords.length; j++)
      cum.push(cum[j - 1]! + Math.hypot((coords[j]![0] - coords[j - 1]![0]) * k, coords[j]![1] - coords[j - 1]![1]));
    return { id: i + 1, i, sport: 'run', coords, starts: [0], cum };
  };
  /** 2 km east along 48.2° N, as 21 vertices. */
  const east = (lat = 48.2): [number, number][] =>
    Array.from({ length: 21 }, (_, j) => [16.3 + (j * 100) / (M_PER_DEG * Math.cos((lat * Math.PI) / 180)), lat]);

  it('sums the points of overlapping routes per cell: same total weight, far fewer features', () => {
    const one = densityPoints([line(0, east())]);
    const ten = densityPoints(Array.from({ length: 10 }, (_, i) => line(i, east())));
    const weight = (d: typeof one) => d.points.features.reduce((s, f) => s + Number(f.properties?.w), 0);
    expect(weight(one)).toBeGreaterThan(45); // a point every ~40 m over 2 km
    expect(weight(ten)).toBe(10 * weight(one));
    expect(ten.points.features.length).toBe(one.points.features.length);
    expect(ten.maxPasses).toBe(10);
  });

  it('keeps the points on the route (mean position of a cell)', () => {
    const d = densityPoints([line(0, east(48.2)), line(1, east(48.2))]);
    for (const f of d.points.features) {
      expect(f.geometry.coordinates[1]).toBeCloseTo(48.2, 9);
      expect(f.geometry.coordinates[0]).toBeGreaterThanOrEqual(16.3);
    }
  });

  it('keeps routes a street apart (~60 m) in separate cells', () => {
    const d = densityPoints([line(0, east(48.2)), line(1, east(48.2 + 60 / M_PER_DEG))]);
    const lats = new Set(d.points.features.map((f) => f.geometry.coordinates[1]!.toFixed(6)));
    expect(lats.size).toBe(2);
  });
});
