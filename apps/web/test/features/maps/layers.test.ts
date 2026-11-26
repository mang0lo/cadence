/**
 * Heatmap and explorer layer helpers (apps/web/src/features/maps/lib/heatmapLayers.ts, explorerLayers.ts) against a
 * fake map with a loaded basemap style.
 */
import { describe, expect, it } from 'vitest';
import { ID, ensureExplorerLayers, explorerColors, visitSteps } from '@/features/maps/lib/explorerLayers';
import { LAYER, ensureHeatLayers, heatPalette } from '@/features/maps/lib/heatmapLayers';
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
