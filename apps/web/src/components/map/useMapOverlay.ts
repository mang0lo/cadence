import { useEffect, useMemo, useRef, useState, type DependencyList, type RefObject } from 'react';
import { Popup, type LngLatLike, type Map, type PopupOptions } from 'maplibre-gl';
import type { MapStylePref } from '@cadence/shared';
import { fitTo, isStyleReady, markStyleReady } from './layers';
import { DARK, LIBERTY } from './styles';

// ---- overlay lifecycle ----------------------------------------------------------------------------------------
// A switch of the basemap or of the light/dark theme replaces the whole style: our sources and layers are gone, and
// until the new style has loaded, adding them throws ("Style is not done loading") and map.getStyle() is undefined.
// Overlay code therefore (1) only touches the map while isStyleReady(map) and (2) applies everything again after every
// style load. These hooks do both, so a component only says what to draw.

/** Handlers passed through to BaseMap. */
export interface OverlayHandlers {
  /** The map instance exists (bind map events here). */
  onReady?: (map: Map) => void;
  /** A style finished loading (initial load, basemap or theme switch): our sources and layers are gone. */
  onStyleLoad?: (map: Map) => void;
}

export interface MapOverlay {
  /** The map, once BaseMap created it. Read it in effects and event handlers, not during render. */
  readonly mapRef: RefObject<Map | null>;
  /** 0 until the first style load, then bumped after every style load. */
  readonly styleVersion: number;
  /** Props for BaseMap: `<BaseMap {...overlay.bind} />`. */
  readonly bind: Required<OverlayHandlers>;
}

/**
 * True when overlays can be changed on `map` right now: the style JSON is loaded (tiles may still be loading).
 * False between setStyle() and 'style.load' — the overlay is applied again after the load anyway.
 */
export function canDraw(map: Map | null | undefined): map is Map {
  return !!map && isStyleReady(map);
}

/** Runs `draw(map)` when the map can take overlay changes now; returns whether it ran. */
export function drawIfReady(map: Map | null | undefined, draw: (map: Map) => void): boolean {
  if (!canDraw(map)) return false;
  draw(map);
  return true;
}

/**
 * MapLibre also replaces the style on its own (it rebuilds it after a lost WebGL context), without BaseMap's
 * setStyle path: mark the style as not ready whenever a new one starts loading. BaseMap's 'style.load' handler marks
 * it ready again. 'styledataloading' fires synchronously inside setStyle, before any effect can run.
 */
function trackStyleLoading(map: Map): void {
  map.on('styledataloading', () => markStyleReady(map, false));
}

/**
 * State of a map with overlays: the map ref, a version that changes after every style load, and the BaseMap props
 * that feed both. Pair it with useOverlayEffect for everything the overlay draws.
 */
export function useMapOverlay(handlers: OverlayHandlers = {}): MapOverlay {
  const mapRef = useRef<Map | null>(null);
  const [styleVersion, setStyleVersion] = useState(0);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const bind = useMemo<Required<OverlayHandlers>>(
    () => ({
      onReady: (map) => {
        mapRef.current = map;
        trackStyleLoading(map);
        handlersRef.current.onReady?.(map);
      },
      onStyleLoad: (map) => {
        mapRef.current = map;
        handlersRef.current.onStyleLoad?.(map);
        setStyleVersion((v) => v + 1);
      },
    }),
    [],
  );
  return { mapRef, styleVersion, bind };
}

/**
 * Effect that adds or changes overlays: runs when `deps` change while the style is loaded, is skipped while a new
 * style loads, and runs again after every style load (which removed the overlays). `draw` must be idempotent.
 */
export function useOverlayEffect(overlay: MapOverlay, draw: (map: Map) => void, deps: DependencyList): void {
  const { mapRef, styleVersion } = overlay;
  useEffect(() => {
    const map = mapRef.current;
    if (styleVersion > 0) drawIfReady(map, draw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleVersion, ...deps]);
}

/** A value that changes every animation frame (a playback position): its current value and every change. */
export interface FrameValue<T> {
  get(): T;
  subscribe(fn: (value: T) => void): () => void;
}

/**
 * useOverlayEffect for a value that changes every frame, without a React render per change: draws the current value
 * of `source` (null when there is none) when `source` or `deps` change and after every style load, then every new
 * value while the style is loaded. `draw` must be idempotent.
 */
export function useOverlayStore<T>(
  overlay: MapOverlay,
  source: FrameValue<T> | null,
  draw: (map: Map, value: T | null) => void,
  deps: DependencyList,
): void {
  const { mapRef, styleVersion } = overlay;
  useEffect(() => {
    if (styleVersion === 0) return;
    const drawValue = (value: T | null) => drawIfReady(mapRef.current, (map) => draw(map, value));
    drawValue(source ? source.get() : null);
    return source?.subscribe(drawValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleVersion, source, ...deps]);
}

/**
 * Fits the map to `bounds` whenever they change or `nonce` is bumped. BaseMap starts with the bounds of the first
 * render, so those are not fitted (and animated) again; bounds that only arrive later are.
 */
export function useFitBounds(
  mapRef: RefObject<Map | null>,
  bounds: [number, number, number, number] | null,
  nonce = 0,
  padding = 40,
): void {
  const key = bounds ? bounds.join(',') : '';
  // key of the bounds BaseMap was created with; null once the first fit decision is made
  const initial = useRef<string | null>(key);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  useEffect(() => {
    const map = mapRef.current;
    const b = boundsRef.current;
    if (!map || !b) return;
    if (initial.current !== null) {
      const unchanged = initial.current === key;
      initial.current = null;
      if (unchanged) return;
    }
    fitTo(map, b, padding, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);
}

/**
 * A MapLibre popup with React content: render it with createPortal(content, el). The popup opens at `at`, moves when
 * `at` changes and closes when it becomes null; when the user closes it on the map (× or a click elsewhere),
 * `onClose` runs so the owner can clear its state.
 */
export function useMapPopup(
  mapRef: RefObject<Map | null>,
  at: LngLatLike | null,
  onClose: () => void,
  options?: PopupOptions,
): HTMLDivElement {
  const el = useMemo(() => document.createElement('div'), []);
  const popupRef = useRef<Popup | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const optionsRef = useRef(options);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!at) {
      const p = popupRef.current;
      popupRef.current = null; // closed by us: no onClose
      p?.remove();
      return;
    }
    if (popupRef.current) {
      popupRef.current.setLngLat(at);
      return;
    }
    const p = new Popup(optionsRef.current).setDOMContent(el);
    p.on('close', () => {
      if (popupRef.current !== p) return;
      popupRef.current = null;
      onCloseRef.current();
    });
    popupRef.current = p;
    p.setLngLat(at).addTo(map);
  }, [at, el, mapRef]);
  return el;
}

/**
 * Style preference of the basemap the map shows right now. BaseMap's built-in switcher only changes its own state, so
 * this can differ from the user's setting; overlay colors (overlayColors) must follow what is shown.
 */
export function shownStylePref(map: Map): MapStylePref {
  const url = map.getStyleUrl();
  if (url === DARK) return 'dark';
  if (url === LIBERTY) return 'outdoor';
  if (url !== null) return 'streets';
  // a style object: the satellite basemap (the only one given as an object), or any basemap MapLibre rebuilt from a
  // snapshot after a lost WebGL context, which only its name tells apart
  if (map.getSource('imagery')) return 'satellite';
  const name = (map.getStyle()?.name ?? '').toLowerCase();
  return name.includes('dark') ? 'dark' : name.includes('liberty') ? 'outdoor' : 'streets';
}
