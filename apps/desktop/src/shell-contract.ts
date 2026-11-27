/**
 * What the desktop shells and the server agree on (packages/shared/src/shell.ts: the server's exit code for a restart,
 * the line it announces its address with, the bridge messages, ShellInfo), and what this shell does with it: reading
 * the listening line, the environment the server is started with, checking the messages the page posts. The Mac app
 * keeps the same values in apps/macos/Sources/Cadence/ShellContract.swift; the server's side is in apps/server/src
 * (server.ts, config.ts), the web UI's in apps/web/src/lib/native.ts. apps/desktop/test/shell-contract.test.ts checks
 * that all of them still match.
 *
 * No Electron imports here. @cadence/shared is bundled into the app (build.mjs).
 */
import {
  LISTENING_PREFIX,
  NATIVE_CANCELLED_EVENT,
  NATIVE_IMPORT_EVENT,
  type NativeCancelledDetail,
  type NativeImportDetail,
  type NativeMessage,
  type ShellInfo,
} from '@cadence/shared';

export {
  LISTENING_PREFIX,
  NATIVE_CANCELLED_EVENT,
  NATIVE_IMPORT_EVENT,
  NATIVE_MESSAGES,
  RESTART_EXIT_CODE,
  type NativeMessage,
  type ShellInfo,
} from '@cadence/shared';

/** The address from the server's listening line in `output`; null until the whole line is there. */
export function parseListening(output: string): { url: string; port: number } | null {
  const at = output.indexOf(LISTENING_PREFIX);
  const end = at < 0 ? -1 : output.indexOf('\n', at);
  if (end < 0) return null;
  try {
    const { url, port } = JSON.parse(output.slice(at + LISTENING_PREFIX.length, end)) as Record<string, unknown>;
    return typeof url === 'string' && typeof port === 'number' ? { url, port } : null;
  } catch {
    return null;
  }
}

/** The environment the shells start the built-in server with, on top of their own (apps/server/src/config.ts). */
export function shellServerEnv(o: {
  port: number;
  dataDir: string;
  webDir: string;
  /** The app: the server exits when it is gone. */
  parentPid: number;
}): Record<string, string> {
  return {
    CADENCE_MODE: 'desktop',
    PORT: String(o.port),
    HOST: '127.0.0.1',
    CADENCE_DATA_DIR: o.dataDir,
    CADENCE_WEB_DIR: o.webDir,
    CADENCE_PARENT_PID: String(o.parentPid),
    NODE_ENV: 'production',
  };
}

/** A message as the page posted it (any value) → the message, or null when it is none the shells know. */
export function parseBridgeMessage(raw: unknown): NativeMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'pickImportFile':
      return { type: 'pickImportFile', folder: m.folder === true };
    case 'importReady':
      return { type: 'importReady' };
    case 'openDataFolder':
      return { type: 'openDataFolder' };
    case 'saveFile':
      return typeof m.filename === 'string' && m.filename && typeof m.base64 === 'string' && m.base64
        ? { type: 'saveFile', filename: m.filename, base64: m.base64 }
        : null;
    case 'connectServer':
      if (m.url === undefined) return { type: 'connectServer', url: '' };
      return typeof m.url === 'string' ? { type: 'connectServer', url: m.url } : null;
    default:
      return null;
  }
}

/**
 * Script for the page (executeJavaScript): hands it a path to import as NATIVE_IMPORT_EVENT. Its value is true when
 * the import page took it (the page cancels the event), false when no import page listens.
 */
export function importEventScript(detail: NativeImportDetail): string {
  const event = `new CustomEvent(${JSON.stringify(NATIVE_IMPORT_EVENT)}, { detail: ${JSON.stringify(detail)}, cancelable: true })`;
  return `!window.dispatchEvent(${event})`;
}

/**
 * Script for the page: the user cancelled what message `type` asked for (NATIVE_CANCELLED_EVENT). The page that waits
 * for the answer takes the event; any other page is reloaded, as the shells did before the event existed.
 */
export function cancelledEventScript(type: NativeMessage['type']): string {
  const detail: NativeCancelledDetail = { type };
  const event = `new CustomEvent(${JSON.stringify(NATIVE_CANCELLED_EVENT)}, { detail: ${JSON.stringify(detail)}, cancelable: true })`;
  return `if (window.dispatchEvent(${event})) location.reload();`;
}

/** What the web UI shows in Settings → Server (`window.cadenceNative.info` here). */
export function shellInfo(app: ShellInfo['app'], version: string, remote: string | null): ShellInfo {
  return { app, version, remote };
}
