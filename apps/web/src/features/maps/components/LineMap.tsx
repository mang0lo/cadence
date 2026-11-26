import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { MapStylePref } from '@cadence/shared';
import { BaseMap } from '@/components/map/BaseMap';
import { overlayColors } from '@/components/map/styles';
import { shownStylePref, useFitBounds, useMapOverlay, useOverlayEffect } from '@/components/map/useMapOverlay';
import { useSettings } from '@/lib/settings';
import { useResolvedTheme } from '@/lib/theme';
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
  /** After every style load: the basemap shown (the built-in switcher can differ from the setting). */
  onStylePref?: (pref: MapStylePref) => void;
  children?: ReactNode;
}

const NO_MARKERS: MapMarker[] = [];

/**
 * Overlay colors (casing, muted lines) for the basemap a LineMap shows: pass `onStylePref` to that LineMap. Colors
 * from settings.mapStyle alone stay light-map colors after the map's own switcher changed to satellite or dark.
 */
export function useShownOverlayColors(): [ReturnType<typeof overlayColors>, (pref: MapStylePref) => void] {
  const { settings } = useSettings();
  const theme = useResolvedTheme();
  const [pref, setPref] = useState<MapStylePref>(settings.mapStyle);
  return [overlayColors(pref, theme), setPref];
}

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
  onStylePref,
  children,
}: LineMapProps) {
  // what is drawn per item (only changed items are updated: the segment editor's hover marker moves on every pointer
  // move); a new style starts without our layers
  const drawn = useRef<LineOverlayState>(new Map());
  const overlay = useMapOverlay({
    onReady,
    onStyleLoad: (map) => {
      drawn.current = new Map();
      onStylePref?.(shownStylePref(map));
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
