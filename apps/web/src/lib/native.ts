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

declare global {
  interface Window {
    webkit?: { messageHandlers?: { cadence?: NativeBridge } };
    cadenceNative?: NativeBridge & { platform: string };
  }
}

export const NATIVE_IMPORT_EVENT = 'cadence:native-import';

const bridge = (): NativeBridge | undefined =>
  window.webkit?.messageHandlers?.cadence ?? window.cadenceNative;

export function isNativeShell(): boolean {
  return !!bridge();
}

export function postNative(type: string, payload: Record<string, unknown> = {}): boolean {
  const bridge = window.webkit?.messageHandlers?.cadence ?? window.cadenceNative;
  if (!bridge) return false;
  bridge.postMessage({ type, ...payload });
  return true;
}
