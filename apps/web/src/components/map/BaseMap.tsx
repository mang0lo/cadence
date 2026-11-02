import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Map as MapLibre, NavigationControl, ScaleControl, setWorkerUrl, type Map } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Layers, Mountain } from 'lucide-react';
import type { MapStylePref } from '@cadence/shared';
import { cn } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { useResolvedTheme } from '@/lib/theme';
import { MAP_STYLE_KEYS, mapStyleFor, TERRAIN_SOURCE, TERRAIN_SOURCE_ID } from './styles';

// MapLibre 6 resolves its worker relative to its own module, which bundlers relocate — point it at
// the Vite-bundled worker instead.
setWorkerUrl(maplibreWorkerUrl);

export type { Map };

export interface BaseMapProps {
  className?: string;
  /** Overrides the user's default map style. */
  styleKey?: MapStylePref;
  /** Initial view: [minLon, minLat, maxLon, maxLat] … */
  bounds?: [number, number, number, number] | null;
  /** … or center/zoom. */
  center?: [number, number];
  zoom?: number;
  padding?: number;
  interactive?: boolean;
  /** 3D terrain (raster DEM) + sky. */
  terrain?: boolean;
  terrainExaggeration?: number;
  /** Built-in style switcher + 3D toggle in the top-right corner. */
  switcher?: boolean;
  controls?: boolean;
  /** Called once when the map instance exists. */
  onReady?: (map: Map) => void;
  /**
   * Called after EVERY style load (initial and after switching style/theme). Add your sources and
   * layers here — switching the basemap removes them.
   */
  onStyleLoad?: (map: Map) => void;
  /** Overlay UI (absolutely positioned children). */
  children?: ReactNode;
}

/** MapLibre map that follows the user's style preference and light/dark theme. */
export function BaseMap({
  className,
  styleKey,
  bounds,
  center,
  zoom,
  padding = 40,
  interactive = true,
  terrain: terrainProp = false,
  terrainExaggeration = 1.4,
  switcher = true,
  controls = true,
  onReady,
  onStyleLoad,
  children,
}: BaseMapProps) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const { settings } = useSettings();
  const theme = useResolvedTheme();
  const t = useT();
  const [pref, setPref] = useState<MapStylePref>(styleKey ?? settings.mapStyle);
  const [terrain, setTerrain] = useState(terrainProp);
  const [menu, setMenu] = useState(false);
  const styleLoadRef = useRef(onStyleLoad);
  styleLoadRef.current = onStyleLoad;
  const terrainRef = useRef(terrain);
  terrainRef.current = terrain;

  useEffect(() => setPref(styleKey ?? settings.mapStyle), [styleKey, settings.mapStyle]);
  useEffect(() => setTerrain(terrainProp), [terrainProp]);

  const applyTerrain = (map: Map, on: boolean) => {
    if (on) {
      if (!map.getSource(TERRAIN_SOURCE_ID)) map.addSource(TERRAIN_SOURCE_ID, TERRAIN_SOURCE);
      map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: terrainExaggeration });
      try {
        map.setSky({ 'sky-color': '#9cc3ef', 'horizon-color': '#e8eef5', 'sky-horizon-blend': 0.6 });
      } catch {
        /* sky unsupported */
      }
    } else if (map.getTerrain()) {
      map.setTerrain(null);
    }
  };

  // create once
  useEffect(() => {
    const map = new MapLibre({
      container: el.current!,
      style: mapStyleFor(pref, theme),
      bounds: bounds ?? undefined,
      fitBoundsOptions: { padding },
      center: bounds ? undefined : (center ?? [16.37, 48.21]),
      zoom: bounds ? undefined : (zoom ?? 11),
      interactive,
      attributionControl: { compact: true },
      maxPitch: 80,
      fadeDuration: 150,
    });
    mapRef.current = map;
    if (controls && interactive) {
      map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right');
      map.addControl(new ScaleControl({ unit: settings.units === 'imperial' ? 'imperial' : 'metric' }), 'bottom-left');
    }
    map.on('style.load', () => {
      applyTerrain(map, terrainRef.current);
      styleLoadRef.current?.(map);
    });
    map.on('error', (e) => console.warn('[map]', e.error?.message ?? e));
    if (import.meta.env.DEV) (window as unknown as { __map: Map }).__map = map;
    onReady?.(map);
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(el.current!);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // switch style when preference / theme changes
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    mapRef.current?.setStyle(mapStyleFor(pref, theme), { diff: false });
  }, [pref, theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.isStyleLoaded()) applyTerrain(map, terrain);
    if (map && terrain && map.getPitch() < 30) map.easeTo({ pitch: 55, duration: 800 });
    if (map && !terrain && map.getPitch() > 0) map.easeTo({ pitch: 0, duration: 600 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrain]);

  return (
    <div className={cn('relative overflow-hidden rounded-card bg-surface-2', className)}>
      <div ref={el} className="absolute inset-0" />
      {switcher && interactive && (
        <div className="absolute right-2 top-2 z-10 flex flex-col items-end gap-1.5">
          <div className="flex gap-1.5">
            <button
              onClick={() => setTerrain((v) => !v)}
              className={cn(
                'grid size-8 place-items-center rounded-[10px] border border-border bg-surface text-fg-2 shadow-card hover:text-fg',
                terrain && 'text-accent-fg',
              )}
              title={t('common.map.terrain3d')}
              aria-pressed={terrain}
            >
              <Mountain size={16} />
            </button>
            <button
              onClick={() => setMenu((v) => !v)}
              className="grid size-8 place-items-center rounded-[10px] border border-border bg-surface text-fg-2 shadow-card hover:text-fg"
              title={t('common.map.style')}
              aria-expanded={menu}
            >
              <Layers size={16} />
            </button>
          </div>
          {menu && (
            <div className="flex flex-col overflow-hidden rounded-[10px] border border-border bg-surface text-sm shadow-pop">
              {MAP_STYLE_KEYS.map((k) => (
                <button
                  key={k}
                  onClick={() => {
                    setPref(k);
                    setMenu(false);
                  }}
                  className={cn('px-3 py-1.5 text-left hover:bg-surface-2', k === pref ? 'font-semibold text-fg' : 'text-fg-2')}
                >
                  {t(`common.map.styles.${k}`)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
