import type { Map as MapLibreMap } from 'maplibre-gl';

/**
 * First symbol (label) layer of the basemap: overlays are inserted below it so labels stay readable. Walks the layer
 * order instead of map.getStyle(), which serializes the whole style (every layer and source) on each call.
 */
export function firstSymbolLayer(map: MapLibreMap): string | undefined {
  return map.getLayersOrder().find((id) => map.getLayer(id)?.type === 'symbol');
}
