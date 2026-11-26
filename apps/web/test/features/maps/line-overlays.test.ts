/** Lines and markers of the route / segment maps (apps/web/src/features/maps/lib/lineOverlays.ts). */
import { describe, expect, it } from 'vitest';
import type { LngLat } from '@/components/map/layers';
import {
  syncLineOverlays,
  type LineOverlayState,
  type MapLine,
  type MapMarker,
} from '@/features/maps/lib/lineOverlays';
import { FakeLayerMap } from './fake-map';

const route: LngLat[] = Array.from({ length: 1200 }, (_, i) => [16.3 + i * 1e-4, 48.2]);
const selected: LngLat[] = route.slice(400, 800);

const lines = (accent = '#e8590c'): MapLine[] => [
  { id: 'route', lines: [route], color: 'rgba(30,30,30,0.35)', width: 4, casing: '#fff' },
  { id: 'selected', lines: [selected], color: accent, width: 6, casing: '#fff' },
];
const markers = (hover: LngLat | null): MapMarker[] => [
  { id: 'start', coord: selected[0]!, color: 'green', radius: 7 },
  { id: 'hover', coord: hover, color: 'orange', radius: 5 },
];

describe('syncLineOverlays', () => {
  it('creates a source and layers per item, the casing below the line', () => {
    const m = new FakeLayerMap([['roads', 'line']]);
    syncLineOverlays(m.map, lines(), markers(null), new Map());
    expect(Object.keys(m.sources).sort()).toEqual(['lm-hover', 'lm-route', 'lm-selected', 'lm-start']);
    expect(m.added('lm-')).toEqual([
      'lm-route-casing',
      'lm-route',
      'lm-selected-casing',
      'lm-selected',
      'lm-start',
      'lm-hover',
    ]);
  });

  it('moving the hover marker re-uploads only that point', () => {
    const m = new FakeLayerMap();
    const drawn: LineOverlayState = new Map();
    const l = lines();
    syncLineOverlays(m.map, l, markers(null), drawn);
    m.resetCalls();
    syncLineOverlays(m.map, l, markers([16.31, 48.2]), drawn);
    syncLineOverlays(m.map, l, markers([16.32, 48.2]), drawn);
    expect(m.calls).toEqual(['setData lm-hover', 'setData lm-hover']);
  });

  it('treats unchanged parts in a new wrapper array as unchanged, and recolors without new data', () => {
    const m = new FakeLayerMap();
    const drawn: LineOverlayState = new Map();
    syncLineOverlays(m.map, lines(), markers(null), drawn);
    m.resetCalls();
    syncLineOverlays(m.map, lines(), markers(null), drawn); // new MapLine objects, same coordinates
    expect(m.calls).toEqual([]);
    syncLineOverlays(m.map, lines('#2a78d6'), markers(null), drawn);
    expect(m.calls.every((c) => c.startsWith('paint lm-selected'))).toBe(true);
    expect(m.layers['lm-selected']!.paint['line-color']).toBe('#2a78d6');
  });

  it('updates a line whose coordinates changed and removes items that are gone', () => {
    const m = new FakeLayerMap();
    const drawn: LineOverlayState = new Map();
    syncLineOverlays(m.map, lines(), markers(null), drawn);
    m.resetCalls();
    const moved: MapLine[] = [lines()[0]!, { ...lines()[1]!, lines: [route.slice(500, 900)] }];
    syncLineOverlays(m.map, moved, [], drawn);
    expect(m.calls.filter((c) => c.startsWith('setData'))).toEqual(['setData lm-selected']);
    expect(m.sources['lm-hover']).toBeUndefined();
    expect(m.layers['lm-start']).toBeUndefined();
    expect([...drawn.keys()]).toEqual(['route', 'selected']);
  });

  it('draws everything again on a new style (fresh state)', () => {
    const before = new FakeLayerMap();
    const drawn: LineOverlayState = new Map();
    syncLineOverlays(before.map, lines(), markers(null), drawn);
    const after = new FakeLayerMap(); // the style switch removed every source and layer
    syncLineOverlays(after.map, lines(), markers(null), new Map());
    expect(after.added('lm-')).toEqual(before.added('lm-'));
  });
});
