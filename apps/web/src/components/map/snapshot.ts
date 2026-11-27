/**
 * Static map images for route previews and share images: one hidden MapLibre map renders an OpenFreeMap vector style
 * for a given camera, the canvas is saved as a JPEG, and the image is kept in IndexedDB — every preview is rendered
 * once and then shown from the browser like any image (no WebGL per preview, no API key).
 *
 * Previews hold the image they show (`holdSnapshot`): a queued render nobody holds any more (scrolled away, resized
 * to another size) is skipped, and the object URLs of images no preview shows are freed beyond a small reserve.
 *
 * Nothing here touches the DOM at import time (the module is also imported by Node tests through shareImage.ts).
 */
import type { ErrorEvent, Map as MapLibreMap } from 'maplibre-gl';
import { queryClient } from '../../lib/api';
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

/**
 * The first render waits until the page has loaded its data and the browser is idle: downloading MapLibre (about
 * 1.6 MB of script) and starting WebGL must not compete with the first paint of the page (a cold cache on the
 * dashboard). Previews show the plain route until then.
 */
async function pageSettled(): Promise<void> {
  const until = Date.now() + 4000;
  while (queryClient.isFetching() > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 150));
  await new Promise<void>((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 1500 });
    else setTimeout(resolve, 100);
  });
}

async function renderer(style: string): Promise<Renderer> {
  rendererPromise ??= (async () => {
    await pageSettled();
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

export interface Rendered {
  blob: Blob;
  /** False when the fallback style was used: the image is shown but not kept. */
  keep: boolean;
}

/** A queued render that nobody waited for any more when its turn came. */
export const SKIPPED = 'skipped';

/** Render one snapshot; null when the map could not be rendered completely (offline, tile errors, timeout). */
async function renderOne(req: SnapshotRequest, wanted: () => boolean): Promise<Rendered | null | typeof SKIPPED> {
  const wantedStyle = STYLE_URL[req.base];
  const r = await renderer(wantedStyle);
  // the first render waits for the page to settle: the preview may be gone by now
  if (!wanted()) return SKIPPED;
  const { map, el } = r;
  const style = failedStyles.has(wantedStyle) ? FALLBACK_STYLE : wantedStyle;
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
  const keep = r.style === wantedStyle;
  return new Promise<Rendered | null>((resolve) =>
    map.getCanvas().toBlob((blob) => resolve(blob ? { blob, keep } : null), 'image/jpeg', 0.86),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// In-page store: one entry per key with its object URL and the previews holding it; one render at a time.

export interface SnapshotBackend {
  /** The cached image of a key, or null. */
  get(key: string): Promise<Blob | null>;
  /** Render one image (never two at once); SKIPPED when `wanted()` turned false while it waited. */
  render(req: SnapshotRequest, wanted: () => boolean): Promise<Rendered | null | typeof SKIPPED>;
  /** Keep a rendered image in the cache. */
  put(key: string, blob: Blob): void;
  createUrl(blob: Blob): string;
  revokeUrl(url: string): void;
}

export interface SnapshotHold {
  /** Object URL of the image; null when it cannot be rendered. */
  promise: Promise<string | null>;
  /** The preview no longer shows (or waits for) the image. */
  release(): void;
}

export interface SnapshotStore {
  peek(key: string): string | null;
  /** The image without a hold: always rendered, and its URL stays valid for a minute at least. */
  get(req: SnapshotRequest): Promise<string | null>;
  hold(req: SnapshotRequest): SnapshotHold;
}

interface Entry {
  promise: Promise<string | null>;
  url: string | null;
  /** Previews showing or waiting for the image: it is only rendered while someone holds it. */
  holders: number;
  /** Asked for without a hold (share image): rendered in any case, and not freed before `keepUntil`. */
  forced: boolean;
  keepUntil: number;
}

/** Ready images that no preview shows stay in memory up to this number (the most recently used); older ones are freed. */
const MAX_IDLE_URLS = 100;
/** A failed image is tried again when it is asked for after this time (e.g. back online). */
const RETRY_MS = 30_000;
/** How long an image handed out without a hold stays valid at least. */
const FORCED_KEEP_MS = 60_000;

export function createSnapshotStore(backend: SnapshotBackend, maxIdle = MAX_IDLE_URLS): SnapshotStore {
  /** In the order of their last use. */
  const entries = new Map<string, Entry>();
  let queue: Promise<unknown> = Promise.resolve();

  const touch = (key: string, e: Entry) => {
    entries.delete(key);
    entries.set(key, e);
  };
  const drop = (key: string, e: Entry) => {
    if (entries.get(key) === e) entries.delete(key);
  };
  const prune = () => {
    let idle = 0;
    for (const e of entries.values()) if (e.url && e.holders === 0) idle++;
    const now = Date.now();
    for (const [key, e] of entries) {
      if (idle <= maxIdle) break;
      if (!e.url || e.holders > 0 || e.keepUntil > now) continue;
      backend.revokeUrl(e.url);
      entries.delete(key);
      idle--;
    }
  };
  /** Queue a render; whether it is still wanted is decided when its turn comes. */
  const render = (req: SnapshotRequest, wanted: () => boolean) => {
    const job = () => (wanted() ? backend.render(req, wanted) : SKIPPED);
    const p = queue.then(job, job);
    queue = p.catch(() => null);
    return p.catch(() => null);
  };
  const load = (req: SnapshotRequest, forced: boolean): Entry => {
    const key = snapshotKey(req);
    const known = entries.get(key);
    if (known) {
      touch(key, known);
      if (forced) {
        known.forced = true;
        if (known.url) known.keepUntil = Date.now() + FORCED_KEEP_MS;
      }
      return known;
    }
    const e: Entry = { promise: Promise.resolve(null), url: null, holders: 0, forced, keepUntil: 0 };
    const wanted = () => e.forced || e.holders > 0;
    e.promise = (async () => {
      let blob = await backend.get(key);
      if (!blob) {
        let rendered: Rendered | null | typeof SKIPPED;
        do rendered = await render(req, wanted);
        while (rendered === SKIPPED && wanted());
        if (rendered === SKIPPED) {
          // nobody waits for it any more (scrolled away, resized): rendered when it is asked for again
          drop(key, e);
          return null;
        }
        blob = rendered?.blob ?? null;
        if (rendered?.keep) backend.put(key, rendered.blob);
      }
      if (!blob) {
        setTimeout(() => drop(key, e), RETRY_MS);
        return null;
      }
      e.url = backend.createUrl(blob);
      if (e.forced) e.keepUntil = Date.now() + FORCED_KEEP_MS;
      prune();
      return e.url;
    })();
    entries.set(key, e);
    return e;
  };

  return {
    peek(key) {
      const e = entries.get(key);
      if (!e?.url) return null;
      touch(key, e);
      return e.url;
    },
    get: (req) => load(req, true).promise,
    hold(req) {
      const key = snapshotKey(req);
      const e = load(req, false);
      e.holders++;
      let held = true;
      return {
        promise: e.promise,
        release() {
          if (!held) return;
          held = false;
          e.holders--;
          if (entries.get(key) === e) touch(key, e);
          prune();
        },
      };
    },
  };
}

const store = createSnapshotStore({
  get: cacheGet,
  render: renderOne,
  put: (key, blob) => void cachePut(key, blob),
  createUrl: (blob) => URL.createObjectURL(blob),
  revokeUrl: (url) => URL.revokeObjectURL(url),
});

/** The object URL of a snapshot when it is already available in this page (for a flicker-free first render). */
export const peekSnapshot = (key: string): string | null => store.peek(key);

/** Object URL of the map image for a view (from the cache or rendered now); null when it cannot be rendered. */
export const mapSnapshot = (req: SnapshotRequest): Promise<string | null> => store.get(req);

/** The map image of a preview for as long as it is shown: release it when the preview unmounts or changes. */
export const holdSnapshot = (req: SnapshotRequest): SnapshotHold => store.hold(req);
