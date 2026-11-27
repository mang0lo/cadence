/**
 * What the server, the web UI and the desktop shells (the Mac app in apps/macos, the Linux / Windows app in
 * apps/desktop) agree on: the server's exit code for a restart and the line it announces its address with, the
 * messages the web UI posts to the shell, the events the shell answers with, and what the shell tells the web UI
 * about itself.
 *
 * The server (server.ts), the web UI (apps/web/src/lib/native.ts) and the desktop app
 * (apps/desktop/src/shell-contract.ts) import it from here. The Mac app keeps its own copy in
 * apps/macos/Sources/Cadence/ShellContract.swift; apps/desktop/test/shell-contract.test.ts checks that it still
 * matches.
 */

/** Exit code of the server when it restarts itself on purpose (e.g. to apply a restored backup). */
export const RESTART_EXIT_CODE = 75;

/** Start of the line the server writes to stdout once it listens: `CADENCE_LISTENING {"url":"…","port":28787}`. */
export const LISTENING_PREFIX = 'CADENCE_LISTENING ';

/** What the web UI posts to the shell as `{ type, … }` (postNative in apps/web/src/lib/native.ts). */
export type NativeMessage =
  /** The shell's import dialog; `folder`: pick a folder instead of a file (Windows and Linux cannot do both). */
  | { type: 'pickImportFile'; folder?: boolean }
  | { type: 'openDataFolder' }
  /** A file the page made (share image), as base64. */
  | { type: 'saveFile'; filename: string; base64: string }
  /** Settings → Server: show this server from now on ('' = the one built into the app). */
  | { type: 'connectServer'; url: string };

const messageTypes: { [T in NativeMessage['type']]: true } = {
  pickImportFile: true,
  openDataFolder: true,
  saveFile: true,
  connectServer: true,
};

/** Every message type the shells know. */
export const NATIVE_MESSAGES = Object.keys(messageTypes) as NativeMessage['type'][];

/** The shell hands the import page a path on this computer to import: `detail` is a NativeImportDetail. */
export const NATIVE_IMPORT_EVENT = 'cadence:native-import';

export interface NativeImportDetail {
  path: string;
}

/** What the shell tells the web UI about itself, for Settings → Server. */
export interface ShellInfo {
  app: 'macos' | 'desktop';
  /** Version of the app (not of the server it shows). */
  version: string;
  /** The remote Cadence server the app shows, null = the server built into the app. */
  remote: string | null;
}
