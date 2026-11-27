import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Map } from 'maplibre-gl';
import { isStyleReady } from './layers';
import { TERRAIN_SOURCE, TERRAIN_SOURCE_ID } from './styles';

/** Adds the 3D terrain (raster DEM) and the sky to the loaded style, or removes the terrain. */
export function applyTerrain(map: Map, on: boolean, exaggeration: number): void {
  if (on) {
    if (!map.getSource(TERRAIN_SOURCE_ID)) map.addSource(TERRAIN_SOURCE_ID, TERRAIN_SOURCE);
    map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration });
    try {
      map.setSky({ 'sky-color': '#9cc3ef', 'horizon-color': '#e8eef5', 'sky-horizon-blend': 0.6 });
    } catch {
      /* sky unsupported */
    }
  } else if (map.getTerrain()) {
    map.setTerrain(null);
  }
}

export interface TerrainToggle {
  /** Terrain shown: the `terrain` prop, or the 3D button's choice since the prop last changed. */
  on: boolean;
  /** The 3D button: turns the terrain on or off and tilts (or levels) the camera for it. */
  toggle: () => void;
}

/**
 * 3D terrain of a BaseMap. A change of the `terrain` prop only applies the terrain: the owner moves the camera (the
 * activity flyover starts its own camera move in the same commit, and a pitch ease here would stop it). Only the 3D
 * button also tilts the camera. While a new style loads nothing is applied; BaseMap's 'style.load' handler applies the
 * current state.
 */
export function useTerrain(mapRef: RefObject<Map | null>, prop: boolean, exaggeration: number): TerrainToggle {
  const [on, setOn] = useState(prop);
  // a new prop wins over the button; adjusted while rendering (not in an effect), so the terrain is applied in the
  // same commit, before the owner's effects start a camera move for it
  const [propSeen, setPropSeen] = useState(prop);
  if (propSeen !== prop) {
    setPropSeen(prop);
    setOn(prop);
  }
  /** Set by the 3D button: the next terrain change also moves the camera. */
  const tilt = useRef(false);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // not isStyleLoaded(): that is false while tiles load and would drop the change
    if (isStyleReady(map)) applyTerrain(map, on, exaggeration);
    if (!tilt.current) return;
    tilt.current = false;
    if (on && map.getPitch() < 30) map.easeTo({ pitch: 55, duration: 800 });
    if (!on && map.getPitch() > 0) map.easeTo({ pitch: 0, duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);

  return {
    on,
    toggle: () => {
      tilt.current = true;
      setOn((v) => !v);
    },
  };
}
