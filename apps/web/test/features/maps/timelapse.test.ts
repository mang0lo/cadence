/**
 * Heatmap time-lapse on the map (apps/web/src/features/maps/lib/heatmapLayers.ts): which activities are shown is
 * feature state, changed only for the activities whose visibility changes. setFilter re-tiled the whole lines source
 * in the worker on every frame that finished an activity.
 */
import { describe, expect, it } from 'vitest';
import type { MapsHeatmapActivity } from '@cadence/shared';
import {
  LAYER,
  LapseVisibility,
  ensureHeatLayers,
  heatPalette,
  toHeatLines,
} from '@/features/maps/lib/heatmapLayers';
import { FakeLayerMap } from './fake-map';

const SRC = 'hm-lines';

/** A map with the heat layers, like after a style load. */
function heatMap(): FakeLayerMap {
  const m = new FakeLayerMap([['labels', 'symbol']]);
  ensureHeatLayers(m.map, heatPalette('hot', true));
  m.resetCalls();
  return m;
}
const hidden = (m: FakeLayerMap) =>
  Object.entries(m.state[SRC] ?? {})
    .filter(([, s]) => s.hidden)
    .map(([id]) => Number(id))
    .sort((a, b) => a - b);

describe('time-lapse visibility', () => {
  it('starts by hiding every activity not finished yet, then reveals one per finished activity', () => {
    const m = heatMap();
    const v = new LapseVisibility();
    v.apply(m.map, 0, 5);
    expect(hidden(m)).toEqual([0, 1, 2, 3, 4]);
    m.resetCalls();
    v.apply(m.map, 1, 5);
    v.apply(m.map, 1, 5); // a frame that finishes nothing
    v.apply(m.map, 2, 5);
    expect(m.calls).toEqual([`state ${SRC}`, `state ${SRC}`]); // two feature-state updates, no filter, no re-tiling
    expect(hidden(m)).toEqual([2, 3, 4]);
  });

  it('hides again when scrubbing back and shows everything when the time-lapse ends', () => {
    const m = heatMap();
    const v = new LapseVisibility();
    v.apply(m.map, 4, 5);
    v.apply(m.map, 1, 5);
    expect(hidden(m)).toEqual([1, 2, 3, 4]);
    v.apply(m.map, null, 5);
    expect(hidden(m)).toEqual([]);
    m.resetCalls();
    v.apply(m.map, null, 5);
    expect(m.calls).toEqual([]);
  });

  it('keeps no stale state when the data changes (ids are positions) and starts over on the source of a new style', () => {
    const m = heatMap();
    const v = new LapseVisibility();
    v.apply(m.map, 3, 5);
    v.apply(m.map, 1, 3); // fewer activities after a filter change
    expect(hidden(m)).toEqual([1, 2]);
    v.apply(m.map, 4, 6); // more again: ids 3 and 4 were hidden for the old data and must not stay so
    expect(hidden(m)).toEqual([4, 5]);
    // style switch: a new map style with a new (empty) lines source
    const next = heatMap();
    v.apply(next.map, 1, 3);
    expect(hidden(next)).toEqual([1, 2]);
    expect(next.calls).not.toContain(`removeState ${SRC}`);
  });

  it('uses feature state in the line opacity, and no filters', () => {
    const m = heatMap();
    for (const id of [LAYER.glow, LAYER.mid, LAYER.core, LAYER.hot]) {
      expect(JSON.stringify(m.layers[id]!.paint['line-opacity'])).toContain('feature-state');
      expect(m.layers[id]!.filter).toBeUndefined();
    }
    expect(m.sources[SRC]!.promoteId).toBe('i');
  });
});

describe('heat lines', () => {
  it('number the drawable routes without gaps (the feature ids of the time-lapse)', () => {
    const item = (id: number, polyline: string): MapsHeatmapActivity =>
      ({ id, sport: 'run', startTs: id, tzMin: 0, polyline }) as MapsHeatmapActivity;
    const route = '_p~iF~ps|U_ulLnnqC_mqNvxq`@'; // Google's reference polyline, 3 points
    const point = '_p~iF~ps|U'; // its first point alone: nothing to draw
    const lines = toHeatLines([item(1, route), item(2, point), item(3, route)]);
    expect(lines.map((l) => [l.id, l.i])).toEqual([
      [1, 0],
      [3, 1],
    ]);
  });
});
