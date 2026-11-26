/**
 * Overlay lifecycle of the maps pages (apps/web/src/components/map/useMapOverlay.ts). A theme or basemap switch
 * replaces the map style; until the new one has loaded, adding a source or layer throws ("Style is not done loading")
 * and map.getStyle() is undefined. Overlay effects that ran in that window crashed the Explorer, route and segment
 * pages on a theme toggle and the heatmap on a basemap switch during the time-lapse.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map } from 'maplibre-gl';
import { markStyleReady } from '@/components/map/layers';
import type { MapStylePref } from '@cadence/shared';
import { DARK, LIBERTY, POSITRON, overlayColors } from '@/components/map/styles';
import {
  shownStylePref,
  useFitBounds,
  useMapOverlay,
  useOverlayEffect,
  type MapOverlay,
} from '@/components/map/useMapOverlay';
import { renderHook } from './fake-react';

vi.mock('react', async () => (await import('./fake-react')).fakeReact);

type Handler = (e: unknown) => void;

/** The parts of a MapLibre map the hooks use, with MapLibre's event semantics. */
class FakeMap {
  private handlers: Record<string, Set<Handler>> = {};
  styleUrl: string | null = POSITRON;
  fitBounds = vi.fn();
  on(type: string, fn: Handler) {
    (this.handlers[type] ??= new Set()).add(fn);
    return this;
  }
  off(type: string, fn: Handler) {
    this.handlers[type]?.delete(fn);
    return this;
  }
  fire(type: string) {
    for (const fn of [...(this.handlers[type] ?? [])]) fn({ type });
  }
  getStyleUrl() {
    return this.styleUrl;
  }
  isStyleLoaded() {
    return false;
  }
}

const asMap = (m: FakeMap) => m as unknown as Map;

/** What BaseMap does: not ready at creation, ready on 'style.load' (then onStyleLoad), onReady once. */
function mountBaseMap(map: FakeMap, overlay: MapOverlay): void {
  markStyleReady(asMap(map), false);
  map.on('style.load', () => {
    markStyleReady(asMap(map), true);
    overlay.bind.onStyleLoad(asMap(map));
  });
  overlay.bind.onReady(asMap(map));
}

/** BaseMap's own switch (theme / basemap): marked not ready right before setStyle, which fires 'styledataloading'. */
function baseMapSetStyle(map: FakeMap, url: string | null): void {
  markStyleReady(asMap(map), false);
  map.styleUrl = url;
  map.fire('styledataloading');
}

describe('overlay effects follow the style lifecycle', () => {
  let map: FakeMap;
  let drawn: unknown[];

  beforeEach(() => {
    map = new FakeMap();
    drawn = [];
  });

  /** A component with one overlay effect that draws `value`. */
  const mount = (value: string) => {
    const h = renderHook(
      ({ value }: { value: string }) => {
        const overlay = useMapOverlay();
        useOverlayEffect(overlay, () => drawn.push(value), [value]);
        return overlay;
      },
      { value },
    );
    mountBaseMap(map, h.result.current);
    return h;
  };

  it('draws once the first style has loaded, not before', () => {
    const h = mount('a');
    expect(drawn).toEqual([]);
    h.rerender({ value: 'b' });
    expect(drawn).toEqual([]); // the initial style is still loading
    map.fire('style.load');
    expect(drawn).toEqual(['b']);
    expect(h.result.current.styleVersion).toBe(1);
  });

  it('skips changes while a theme or basemap switch loads the new style, then draws the latest state', () => {
    const h = mount('light');
    map.fire('style.load');
    expect(drawn).toEqual(['light']);
    // theme toggle: BaseMap (a child, so its effect runs first) switches the style, then new overlay colors arrive
    baseMapSetStyle(map, DARK);
    h.rerender({ value: 'dark' });
    h.rerender({ value: 'dark, hovered' });
    expect(drawn).toEqual(['light']); // nothing touched the unloaded style
    map.fire('style.load');
    expect(drawn).toEqual(['light', 'dark, hovered']); // re-applied once from the latest props
  });

  it('also pauses for a style MapLibre loads by itself (rebuilt after a lost WebGL context)', () => {
    const h = mount('a');
    map.fire('style.load');
    map.fire('styledataloading'); // MapLibre's own setStyle: BaseMap did not mark it
    h.rerender({ value: 'b' });
    expect(drawn).toEqual(['a']);
    map.fire('style.load');
    expect(drawn).toEqual(['a', 'b']);
  });

  it('draws changes right away while the style is loaded', () => {
    const h = mount('a');
    map.fire('style.load');
    h.rerender({ value: 'b' });
    h.rerender({ value: 'b' }); // unchanged: no redraw
    expect(drawn).toEqual(['a', 'b']);
  });

  it('applies a change made while tiles or sources load (map.isStyleLoaded() is false then)', () => {
    // the heatmap palette effect used to return on !isStyleLoaded() and never ran again: the new colors were lost
    const h = mount('hot');
    map.fire('style.load');
    expect(map.isStyleLoaded()).toBe(false); // tiles of the basemap or the time-lapse sources are loading
    h.rerender({ value: 'blue' });
    expect(drawn).toEqual(['hot', 'blue']);
  });

  it('passes the map to onReady and onStyleLoad', () => {
    const ready = vi.fn();
    const loaded = vi.fn();
    const h = renderHook(() => useMapOverlay({ onReady: ready, onStyleLoad: loaded }), {});
    mountBaseMap(map, h.result.current);
    map.fire('style.load');
    expect(ready).toHaveBeenCalledWith(map);
    expect(loaded).toHaveBeenCalledWith(map);
    expect(h.result.current.mapRef.current).toBe(map);
  });
});

describe('fit to bounds', () => {
  const A: [number, number, number, number] = [16.3, 48.1, 16.5, 48.3];
  const B: [number, number, number, number] = [11.5, 48.0, 11.7, 48.2];

  const mount = (bounds: typeof A | null, nonce = 0) => {
    const map = new FakeMap();
    const h = renderHook(
      ({ bounds, nonce }: { bounds: typeof A | null; nonce: number }) => {
        const overlay = useMapOverlay();
        // BaseMap creates the map (its effect runs before the parent's)
        if (!overlay.mapRef.current) overlay.bind.onReady(asMap(map));
        useFitBounds(overlay.mapRef, bounds, nonce, 48);
      },
      { bounds, nonce },
    );
    return { map, h };
  };

  it('does not fit the bounds the map was created with, but later ones and every nonce bump', () => {
    const { map, h } = mount(A);
    expect(map.fitBounds).not.toHaveBeenCalled();
    h.rerender({ bounds: [...A], nonce: 0 }); // same bounds, new array
    expect(map.fitBounds).not.toHaveBeenCalled();
    h.rerender({ bounds: B, nonce: 0 });
    expect(map.fitBounds).toHaveBeenLastCalledWith(B, { padding: 48, animate: true, maxZoom: 16 });
    h.rerender({ bounds: B, nonce: 1 });
    expect(map.fitBounds).toHaveBeenCalledTimes(2);
  });

  it('fits bounds that only arrive after the map was created without any', () => {
    const { map, h } = mount(null);
    h.rerender({ bounds: A, nonce: 0 });
    expect(map.fitBounds).toHaveBeenCalledWith(A, { padding: 48, animate: true, maxZoom: 16 });
  });
});

describe('shown basemap', () => {
  it('is reported after each style load, also when the map’s own switcher changed it (route overlay colors)', () => {
    const map = new FakeMap();
    const prefs: MapStylePref[] = [];
    const h = renderHook(() => useMapOverlay({ onStyleLoad: (m) => prefs.push(shownStylePref(m)) }), {});
    mountBaseMap(map, h.result.current);
    map.fire('style.load');
    baseMapSetStyle(map, null); // satellite picked in the map's switcher; the setting still says streets
    map.fire('style.load');
    expect(prefs).toEqual(['streets', 'satellite']);
    expect(overlayColors(prefs[1]!, 'light').casing).toBe(overlayColors('dark', 'light').casing);
  });

  it('tells the style the map shows, whatever the setting says', () => {
    const map = new FakeMap();
    for (const [url, pref] of [
      [POSITRON, 'streets'],
      [DARK, 'dark'],
      [LIBERTY, 'outdoor'],
      [null, 'satellite'],
    ] as const) {
      map.styleUrl = url;
      expect(shownStylePref(asMap(map))).toBe(pref);
    }
  });
});
