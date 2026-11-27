/**
 * Bridge to the native shells: macOS (apps/macos, WKWebView) and Linux / Windows (apps/desktop, Electron preload).
 * In a normal browser none of this exists. The messages and events are the shell contract
 * (packages/shared/src/shell.ts).
 *
 *  JS → native:  window.webkit.messageHandlers.cadence.postMessage({ type: 'pickImportFile' })   (macOS)
 *                window.cadenceNative.postMessage({ type: 'pickImportFile' })                     (Electron)
 *  native → JS:  window.dispatchEvent(new CustomEvent('cadence:native-import', { detail: { path } }))
 */
import { NATIVE_IMPORT_EVENT, type NativeImportDetail, type NativeMessage, type ShellInfo } from '@cadence/shared';

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
export type { NativeImportDetail, ShellInfo } from '@cadence/shared';

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

/**
 * The import page: takes the paths the shell hands over (NATIVE_IMPORT_EVENT) and asks the shell for the one it kept
 * for this page (importReady). Taking a path cancels the event, which tells the shell the page has it. Returns the
 * unsubscribe function. Outside the shells nothing hands over paths.
 */
export function onNativeImport(take: (detail: NativeImportDetail) => void): () => void {
  if (!isNativeShell()) return () => undefined;
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<Partial<NativeImportDetail> | null>).detail;
    if (typeof detail?.path !== 'string' || !detail.path) return;
    e.preventDefault();
    take({ path: detail.path, confirm: detail.confirm === true });
  };
  window.addEventListener(NATIVE_IMPORT_EVENT, listener);
  postNative('importReady');
  return () => window.removeEventListener(NATIVE_IMPORT_EVENT, listener);
}
