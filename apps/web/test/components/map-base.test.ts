/**
 * BaseMap's style and terrain state (apps/web/src/components/map/layers.ts trackStyleReady,
 * apps/web/src/components/map/terrain.ts useTerrain), against a fake map with MapLibre's event order.
 *
 * - MapLibre rebuilds the style by itself after a lost WebGL context, without BaseMap's setStyle: overlays of every
 *   map (not only those of the maps pages) must wait for that new style too.
 * - The activity map's flyover starts its own camera move in the commit that turns the `terrain` prop on; a pitch
 *   ease of BaseMap for the prop stopped it (MapLibre stops the running animation when a new one starts).
 */
import { describe, expect, it, vi } from 'vitest';
import type { Map } from 'maplibre-gl';
import { isStyleReady, markStyleReady, trackStyleReady, whenStyleReady } from '@/components/map/layers';
import { TERRAIN_SOURCE_ID } from '@/components/map/styles';
import { useTerrain } from '@/components/map/terrain';
import { renderHook } from '../features/maps/fake-react';

vi.mock('react', async () => (await import('../features/maps/fake-react')).fakeReact);

type Handler = (e: unknown) => void;

class FakeMap {
  private handlers: Record<string, Handler[]> = {};
  sources: string[] = [];
  terrain: unknown = null;
  pitch = 0;
  setTerrain = vi.fn((t: unknown) => {
    this.terrain = t;
  });
  easeTo = vi.fn((o: { pitch?: number }) => {
    if (o.pitch !== undefined) this.pitch = o.pitch;
  });
  setSky = vi.fn();
  on(type: string, fn: Handler) {
    (this.handlers[type] ??= []).push(fn);
    return this;
  }
  off(type: string, fn: Handler) {
    this.handlers[type] = (this.handlers[type] ?? []).filter((h) => h !== fn);
    return this;
  }
  once(type: string, fn: Handler) {
    const once: Handler = (e) => {
      this.off(type, once);
      fn(e);
    };
    return this.on(type, once);
  }
  fire(type: string) {
    for (const fn of [...(this.handlers[type] ?? [])]) fn({ type });
  }
  isStyleLoaded() {
    return false;
  }
  getSource(id: string) {
    return this.sources.includes(id) ? { id } : undefined;
  }
  addSource(id: string) {
    this.sources.push(id);
  }
  getTerrain() {
    return this.terrain;
  }
  getPitch() {
    return this.pitch;
  }
}

const asMap = (m: FakeMap) => m as unknown as Map;

describe('trackStyleReady', () => {
  it('is not ready until the first style has loaded', () => {
    const map = new FakeMap();
    trackStyleReady(asMap(map));
    expect(isStyleReady(asMap(map))).toBe(false);
    map.fire('style.load');
    expect(isStyleReady(asMap(map))).toBe(true);
  });

  it('is not ready while a style MapLibre loads by itself (rebuilt after a lost WebGL context) loads', () => {
    const map = new FakeMap();
    trackStyleReady(asMap(map));
    map.fire('style.load');
    map.fire('styledataloading'); // MapLibre's own setStyle, BaseMap's switch was not involved
    expect(isStyleReady(asMap(map))).toBe(false);
    const draw = vi.fn();
    whenStyleReady(asMap(map), draw);
    expect(draw).not.toHaveBeenCalled();
    map.fire('style.load');
    expect(isStyleReady(asMap(map))).toBe(true);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it('is ready before the other style.load listeners run', () => {
    const map = new FakeMap();
    trackStyleReady(asMap(map));
    let seen: boolean | null = null;
    map.on('style.load', () => (seen = isStyleReady(asMap(map))));
    map.fire('style.load');
    expect(seen).toBe(true);
  });
});

describe('BaseMap terrain', () => {
  const mount = (terrain: boolean) => {
    const map = new FakeMap();
    markStyleReady(asMap(map), true);
    const mapRef = { current: asMap(map) };
    const h = renderHook(({ terrain }: { terrain: boolean }) => useTerrain(mapRef, terrain, 1.4), { terrain });
    return { map, h };
  };

  it('applies a terrain prop change without moving the camera (its owner moves it)', () => {
    const { map, h } = mount(false);
    expect(map.setTerrain).not.toHaveBeenCalled();
    h.rerender({ terrain: true });
    expect(h.result.current.on).toBe(true);
    expect(map.setTerrain).toHaveBeenLastCalledWith({ source: TERRAIN_SOURCE_ID, exaggeration: 1.4 });
    expect(map.sources).toContain(TERRAIN_SOURCE_ID);
    h.rerender({ terrain: false });
    expect(map.setTerrain).toHaveBeenLastCalledWith(null);
    expect(map.easeTo).not.toHaveBeenCalled();
  });

  it('tilts the camera for the 3D button and levels it again', () => {
    const { map, h } = mount(false);
    h.result.current.toggle();
    expect(h.result.current.on).toBe(true);
    expect(map.setTerrain).toHaveBeenLastCalledWith({ source: TERRAIN_SOURCE_ID, exaggeration: 1.4 });
    expect(map.easeTo).toHaveBeenLastCalledWith({ pitch: 55, duration: 800 });
    h.result.current.toggle();
    expect(h.result.current.on).toBe(false);
    expect(map.setTerrain).toHaveBeenLastCalledWith(null);
    expect(map.easeTo).toHaveBeenLastCalledWith({ pitch: 0, duration: 600 });
    expect(map.easeTo).toHaveBeenCalledTimes(2);
    // a later prop change moves no camera
    h.rerender({ terrain: true });
    expect(map.easeTo).toHaveBeenCalledTimes(2);
  });

  it('keeps the 3D button’s choice until the prop changes', () => {
    const { h } = mount(false);
    h.result.current.toggle();
    h.rerender({ terrain: false }); // same prop: the button's choice stays
    expect(h.result.current.on).toBe(true);
    h.rerender({ terrain: true });
    h.rerender({ terrain: false }); // a new prop wins
    expect(h.result.current.on).toBe(false);
  });

  it('leaves the terrain to the style.load handler while a new style loads', () => {
    const { map, h } = mount(false);
    markStyleReady(asMap(map), false);
    h.rerender({ terrain: true });
    expect(h.result.current.on).toBe(true);
    expect(map.setTerrain).not.toHaveBeenCalled();
  });
});
