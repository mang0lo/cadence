/**
 * What the desktop shells and the server agree on: the server's exit code for a restart, the line it announces its
 * address with, the environment it is started with, and the bridge between the web UI and the shell (messages,
 * ShellInfo). The Mac app keeps the same values in apps/macos/Sources/Cadence/ShellContract.swift; the server's side
 * is in apps/server/src (server.ts, config.ts, core/backup-routes.ts), the web UI's in apps/web/src/lib/native.ts.
 * apps/desktop/test/shell-contract.test.ts checks that all of them still match.
 *
 * No Electron imports here.
 */

/** Exit code of the server when it restarts itself on purpose (e.g. to apply a restored backup). */
export const RESTART_EXIT_CODE = 75;

/** Start of the line the server writes to stdout once it listens: `CADENCE_LISTENING {"url":"…","port":28787}`. */
export const LISTENING_PREFIX = 'CADENCE_LISTENING ';

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

/** What the web UI posts through the bridge (postNative in apps/web/src/lib/native.ts). */
export type BridgeMessage =
  /** The native import dialog; `folder`: pick a folder instead of a file (Windows and Linux cannot do both). */
  | { type: 'pickImportFile'; folder: boolean }
  | { type: 'openDataFolder' }
  /** A file the page made (share image), as base64. */
  | { type: 'saveFile'; filename: string; base64: string }
  /** Settings → Server: show this server from now on ('' = the one built into the app). */
  | { type: 'connectServer'; url: string };

export const BRIDGE_MESSAGES = [
  'pickImportFile',
  'openDataFolder',
  'saveFile',
  'connectServer',
] as const satisfies readonly BridgeMessage['type'][];

/** A message as the page posted it (any value) → the message, or null when it is none the shells know. */
export function parseBridgeMessage(raw: unknown): BridgeMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'pickImportFile':
      return { type: 'pickImportFile', folder: m.folder === true };
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

/** What the shell tells the web UI about itself, for Settings → Server (`window.cadenceNative.info` here). */
export interface ShellInfo {
  app: 'macos' | 'desktop';
  /** Version of the app (not of the server it shows). */
  version: string;
  /** The remote Cadence server the app shows, null = the server built into the app. */
  remote: string | null;
}

export function shellInfo(app: ShellInfo['app'], version: string, remote: string | null): ShellInfo {
  return { app, version, remote };
}
