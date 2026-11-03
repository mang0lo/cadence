/**
 * Static map images for route previews and share images: one hidden MapLibre map renders an OpenFreeMap vector style
 * for a given camera, the canvas is saved as a JPEG, and the image is kept in IndexedDB — every preview is rendered
 * once and then shown from the browser like any image (no WebGL per preview, no API key).
 *
 * Nothing here touches the DOM at import time (the module is also imported by Node tests through shareImage.ts).
 */
import type { ErrorEvent, Map as MapLibreMap } from 'maplibre-gl';
import { DARK, FALLBACK_STYLE, LIBERTY, POSITRON } from './styles';
import { unproject, type FitView, type ThumbnailBasemap } from './tiles';

/** Bump when the rendering changes: older cached images are no longer used. */
const SNAPSHOT_VERSION = 1;

const STYLE_URL: Record<Exclude<ThumbnailBasemap, 'satellite'>, string> = {
  light: POSITRON,
  dark: DARK,
  voyager: LIBERTY,
};

export interface SnapshotRequest {
  base: Exclude<ThumbnailBasemap, 'satellite'>;
  /** Size of the image in CSS px; the image has `pixelRatio` times as many pixels. */
  width: number;
  height: number;
  pixelRatio: number;
  /** Camera: unit-square center and CSS px per world unit (see fitTracks). */
  view: FitView;
}

export function snapshotKey(r: SnapshotRequest): string {
  const w = Math.round(r.width);
  const h = Math.round(r.height);
  return [
    `v${SNAPSHOT_VERSION}`,
    r.base,
    `${w}x${h}@${r.pixelRatio}`,
    r.view.cx.toFixed(9),
    r.view.cy.toFixed(9),
    Math.log2(r.view.scale).toFixed(4),
  ].join('|');
}

// ---------------------------------------------------------------------------------------------------------------------
// Persistent cache (IndexedDB). Every call is wrapped: private windows and blocked storage just skip the cache.

const DB_NAME = 'cadence-map-snapshots';
const STORE = 'images';
const MAX_ENTRIES = 600;
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE);
        store.createIndex('at', 'at');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function cacheGet(key: string): Promise<Blob | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as { blob?: Blob } | undefined)?.blob ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

let puts = 0;
async function cachePut(key: string, blob: Blob): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put({ blob, at: Date.now() }, key);
    // now and then drop the oldest images
    if (++puts % 50 === 1) {
      const count = store.count();
      count.onsuccess = () => {
        let excess = count.result - MAX_ENTRIES;
        if (excess <= 0) return;
        const cursor = store.index('at').openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c || excess-- <= 0) return;
          c.delete();
          c.continue();
        };
      };
    }
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Renderer: one hidden map, one job at a time.

interface Renderer {
  map: MapLibreMap;
  el: HTMLDivElement;
  style: string;
}
let rendererPromise: Promise<Renderer> | null = null;
/** Styles that could not be loaded in this page; the fallback style is used instead. */
const failedStyles = new Set<string>();

function waitFor(map: MapLibreMap, event: 'idle' | 'style.load', ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      map.off(event, done);
      resolve(false);
    }, ms);
    function done() {
      window.clearTimeout(timer);
      resolve(true);
    }
    map.once(event, done);
  });
}

async function renderer(style: string): Promise<Renderer> {
  rendererPromise ??= (async () => {
    const [{ Map: MapLibre, setWorkerUrl }, worker] = await Promise.all([
      import('maplibre-gl'),
      import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
    ]);
    setWorkerUrl(worker.default);
    const el = document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    Object.assign(el.style, {
      position: 'fixed',
      left: '-20000px',
      top: '0',
      width: '400px',
      height: '300px',
      pointerEvents: 'none',
    });
    document.body.appendChild(el);
    const map = new MapLibre({
      container: el,
      style,
      center: [0, 0],
      zoom: 1,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      pixelRatio: 2,
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
    });
    const r: Renderer = { map, el, style };
    // a style that cannot be loaded (e.g. renamed upstream) falls back to the light map
    map.on('error', (e) => {
      const url = (e.error as { url?: string } | undefined)?.url;
      if (url && url === r.style && r.style !== FALLBACK_STYLE) {
        failedStyles.add(r.style);
        r.style = FALLBACK_STYLE;
        map.setStyle(FALLBACK_STYLE);
      }
    });
    await waitFor(map, 'style.load', 20_000);
    return r;
  })();
  return rendererPromise;
}

let chain: Promise<unknown> = Promise.resolve();

interface Rendered {
  blob: Blob;
  /** False when the fallback style was used: the image is shown but not kept. */
  keep: boolean;
}

/** Render one snapshot; null when the map could not be rendered completely (offline, tile errors, timeout). */
function renderSnapshot(req: SnapshotRequest): Promise<Rendered | null> {
  const job = async (): Promise<Rendered | null> => {
    const wanted = STYLE_URL[req.base];
    const r = await renderer(wanted);
    const { map, el } = r;
    const style = failedStyles.has(wanted) ? FALLBACK_STYLE : wanted;
    if (r.style !== style) {
      r.style = style;
      map.setStyle(style);
      await waitFor(map, 'style.load', 20_000);
    }
    el.style.width = `${Math.round(req.width)}px`;
    el.style.height = `${Math.round(req.height)}px`;
    map.setPixelRatio(req.pixelRatio);
    map.resize();
    let failed = false;
    const onError = (e: ErrorEvent) => {
      const ev = e as unknown as { tile?: unknown; sourceId?: string };
      if (ev.tile || ev.sourceId) failed = true;
    };
    map.on('error', onError);
    const [lon, lat] = unproject(req.view.cx, req.view.cy);
    // MapLibre's world is 512 CSS px wide at zoom 0
    map.jumpTo({ center: [lon, lat], zoom: Math.max(0, Math.log2(req.view.scale / 512)) });
    map.triggerRepaint();
    const idle = await waitFor(map, 'idle', 20_000);
    map.off('error', onError);
    if (!idle || failed) return null;
    const keep = r.style === wanted;
    return new Promise<Rendered | null>((resolve) =>
      map.getCanvas().toBlob((blob) => resolve(blob ? { blob, keep } : null), 'image/jpeg', 0.86),
    );
  };
  const p = chain.then(job, job);
  chain = p.catch(() => null);
  return p.catch(() => null);
}

// ---------------------------------------------------------------------------------------------------------------------

const urls = new Map<string, Promise<string | null>>();
const ready = new Map<string, string>();

/** The object URL of a snapshot when it is already available in this page (for a flicker-free first render). */
export const peekSnapshot = (key: string): string | null => ready.get(key) ?? null;

/** Object URL of the map image for a view (from the cache or rendered now); null when it cannot be rendered. */
export function mapSnapshot(req: SnapshotRequest): Promise<string | null> {
  const key = snapshotKey(req);
  let p = urls.get(key);
  if (!p) {
    p = (async () => {
      let blob = await cacheGet(key);
      if (!blob) {
        const rendered = await renderSnapshot(req);
        blob = rendered?.blob ?? null;
        if (rendered?.keep) void cachePut(key, rendered.blob);
      }
      if (!blob) {
        // try again later (e.g. back online)
        window.setTimeout(() => urls.delete(key), 30_000);
        return null;
      }
      const url = URL.createObjectURL(blob);
      ready.set(key, url);
      return url;
    })();
    urls.set(key, p);
  }
  return p;
}
