/**
 * Bridge to the native macOS shell (apps/macos). In a normal browser none of this exists.
 *
 *  JS → native:  window.webkit.messageHandlers.cadence.postMessage({ type: 'pickImportFile' })
 *  native → JS:  window.dispatchEvent(new CustomEvent('cadence:native-import', { detail: { path } }))
 */
interface NativeBridge {
  postMessage(msg: { type: string; [k: string]: unknown }): void;
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: { cadence?: NativeBridge } };
  }
}

export const NATIVE_IMPORT_EVENT = 'cadence:native-import';

export function isNativeShell(): boolean {
  return !!window.webkit?.messageHandlers?.cadence;
}

export function postNative(type: string, payload: Record<string, unknown> = {}): boolean {
  const bridge = window.webkit?.messageHandlers?.cadence;
  if (!bridge) return false;
  bridge.postMessage({ type, ...payload });
  return true;
}
