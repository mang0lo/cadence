import { useMemo, useRef, type ReactNode } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { BaseMap } from '@/components/map/BaseMap';
import { useFitBounds, useMapOverlay, useOverlayEffect } from '@/components/map/useMapOverlay';
import type { BBox } from '../lib/home';
import { syncLineOverlays, type LineOverlayState, type MapLine, type MapMarker } from '../lib/lineOverlays';

export type { MapLine, MapMarker };

export interface LineMapProps {
  className?: string;
  lines: MapLine[];
  markers?: MapMarker[];
  bounds: BBox | null;
  /** Bump to fit the bounds again. */
  fitNonce?: number;
  padding?: number;
  /** Built-in basemap / 3D switcher of BaseMap (default on). */
  switcher?: boolean;
  onReady?: (map: MapLibreMap) => void;
  children?: ReactNode;
}

const NO_MARKERS: MapMarker[] = [];

/**
 * A map that draws a handful of styled polylines and point markers (route detail, segment views). Sources and layers
 * are created per id and kept in sync with the props; they are re-created after every basemap style switch.
 */
export function LineMap({
  className,
  lines,
  markers = NO_MARKERS,
  bounds,
  fitNonce = 0,
  padding = 48,
  switcher = true,
  onReady,
  children,
}: LineMapProps) {
  // what is drawn per item (only changed items are updated: the segment editor's hover marker moves on every pointer
  // move); a new style starts without our layers
  const drawn = useRef<LineOverlayState>(new Map());
  const overlay = useMapOverlay({
    onReady,
    onStyleLoad: () => {
      drawn.current = new Map();
    },
  });

  // only while the style is loaded (a theme or basemap switch replaces it), and again after every style load
  useOverlayEffect(overlay, (map) => syncLineOverlays(map, lines, markers, drawn.current), [lines, markers]);

  useFitBounds(overlay.mapRef, bounds, fitNonce, padding);

  const stable = useMemo(() => ({ bounds }), [bounds]);
  return (
    <BaseMap
      className={className}
      bounds={stable.bounds}
      padding={padding}
      switcher={switcher}
      {...overlay.bind}
    >
      {children}
    </BaseMap>
  );
}
