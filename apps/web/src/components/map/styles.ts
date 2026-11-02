import type { StyleSpecification, RasterDEMSourceSpecification } from 'maplibre-gl';
import type { MapStylePref } from '@cadence/shared';
import type { ResolvedTheme } from '@/lib/theme';

/** Free basemaps without API keys (OpenFreeMap / CARTO / Esri imagery). */
const POSITRON = 'https://tiles.openfreemap.org/styles/positron';
const LIBERTY = 'https://tiles.openfreemap.org/styles/liberty';
const DARK = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

const SATELLITE: StyleSpecification = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    imagery: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    },
  },
  layers: [{ id: 'imagery', type: 'raster', source: 'imagery' }],
};

export const MAP_STYLE_KEYS: MapStylePref[] = ['streets', 'outdoor', 'satellite', 'dark'];

/** Resolve a style preference for the current theme ('streets' follows light/dark). */
export function mapStyleFor(pref: MapStylePref, theme: ResolvedTheme): string | StyleSpecification {
  switch (pref) {
    case 'outdoor':
      return LIBERTY;
    case 'satellite':
      return SATELLITE;
    case 'dark':
      return DARK;
    default:
      return theme === 'dark' ? DARK : POSITRON;
  }
}

/** Terrain elevation tiles (AWS open data, Terrarium encoding) for 3D terrain and hillshading. */
export const TERRAIN_SOURCE_ID = 'cadence-terrain';
export const TERRAIN_SOURCE: RasterDEMSourceSpecification = {
  type: 'raster-dem',
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  tileSize: 256,
  encoding: 'terrarium',
  maxzoom: 15,
  attribution: 'Terrain: Mapzen / AWS Open Data',
};

/** Colors for overlays that must read on every basemap (route lines etc.). */
export function overlayColors(pref: MapStylePref, theme: ResolvedTheme) {
  const darkBase = pref === 'satellite' || pref === 'dark' || (pref === 'streets' && theme === 'dark');
  return {
    casing: darkBase ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.95)',
    route: darkBase ? '#ff7a2f' : '#e8590c',
    muted: darkBase ? 'rgba(255,255,255,0.45)' : 'rgba(30,30,30,0.35)',
    darkBase,
  };
}
