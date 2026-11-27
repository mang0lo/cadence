/**
 * Bridge to the native shells: macOS (apps/macos, WKWebView) and Linux / Windows (apps/desktop, Electron preload).
 * In a normal browser none of this exists. The messages and events are the shell contract
 * (packages/shared/src/shell.ts).
 *
 *  JS → native:  window.webkit.messageHandlers.cadence.postMessage({ type: 'pickImportFile' })   (macOS)
 *                window.cadenceNative.postMessage({ type: 'pickImportFile' })                     (Electron)
 *  native → JS:  window.dispatchEvent(new CustomEvent('cadence:native-import', { detail: { path } }))
 */
import type { NativeMessage, ShellInfo } from '@cadence/shared';

interface NativeBridge {
  postMessage(msg: NativeMessage): void;
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: { cadence?: NativeBridge } };
    cadenceNative?: NativeBridge & { platform: string; info?: ShellInfo };
    cadenceShell?: ShellInfo;
  }
}

export { normalizeServerUrl } from './serverUrl';
export { NATIVE_IMPORT_EVENT, type NativeImportDetail, type ShellInfo } from '@cadence/shared';

const bridge = (): NativeBridge | undefined =>
  window.webkit?.messageHandlers?.cadence ?? window.cadenceNative;

export function isNativeShell(): boolean {
  return !!bridge();
}

export function shellInfo(): ShellInfo | null {
  return window.cadenceShell ?? window.cadenceNative?.info ?? null;
}

/** The fields of message `T` besides its type. */
type Fields<T extends NativeMessage['type']> = Omit<Extract<NativeMessage, { type: T }>, 'type'>;

/** Posts a message to the shell; false outside the shells. Messages without required fields need none here. */
export function postNative<T extends NativeMessage['type']>(
  type: T,
  ...fields: {} extends Fields<T> ? [Fields<T>?] : [Fields<T>]
): boolean {
  const target = bridge();
  if (!target) return false;
  target.postMessage({ type, ...fields[0] } as NativeMessage);
  return true;
}
