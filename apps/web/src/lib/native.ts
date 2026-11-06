/**
 * Bridge to the native shells: macOS (apps/macos, WKWebView) and Linux / Windows (apps/desktop, Electron preload).
 * In a normal browser none of this exists.
 *
 *  JS → native:  window.webkit.messageHandlers.cadence.postMessage({ type: 'pickImportFile' })   (macOS)
 *                window.cadenceNative.postMessage({ type: 'pickImportFile' })                     (Electron)
 *  native → JS:  window.dispatchEvent(new CustomEvent('cadence:native-import', { detail: { path } }))
 */
interface NativeBridge {
  postMessage(msg: { type: string; [k: string]: unknown }): void;
}

/** What the native shell tells the web UI about itself (macOS: injected script, Electron: preload). */
export interface ShellInfo {
  app: 'macos' | 'desktop';
  /** Version of the app (not of the server it shows). */
  version: string;
  /** The remote Cadence server the app shows, null = the server built into the app. */
  remote: string | null;
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: { cadence?: NativeBridge } };
    cadenceNative?: NativeBridge & { platform: string; info?: ShellInfo };
    cadenceShell?: ShellInfo;
  }
}

export const NATIVE_IMPORT_EVENT = 'cadence:native-import';

const bridge = (): NativeBridge | undefined =>
  window.webkit?.messageHandlers?.cadence ?? window.cadenceNative;

export function isNativeShell(): boolean {
  return !!bridge();
}

export function shellInfo(): ShellInfo | null {
  return window.cadenceShell ?? window.cadenceNative?.info ?? null;
}

/**
 * "homeserver.local:8787" → "http://homeserver.local:8787": the address of a Cadence server as the apps use it
 * (http or https with a host, no trailing slash); null when it is not one.
 */
export function normalizeServerUrl(text: string): string | null {
  const s = text.trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export function postNative(type: string, payload: Record<string, unknown> = {}): boolean {
  const bridge = window.webkit?.messageHandlers?.cadence ?? window.cadenceNative;
  if (!bridge) return false;
  bridge.postMessage({ type, ...payload });
  return true;
}
