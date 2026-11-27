/**
 * Bridge for the web UI (apps/web/src/lib/native.ts): `window.cadenceNative.postMessage({ type })` reaches the
 * main process. The answer (a picked import file) comes back as a `cadence:native-import` window event.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { ShellInfo } from './shell-contract';

contextBridge.exposeInMainWorld('cadenceNative', {
  platform: process.platform,
  // checked in the main process (parseBridgeMessage, shell-contract.ts)
  postMessage: (msg: { type: string; [k: string]: unknown }) => ipcRenderer.send('cadence', msg),
  // app version and the server in use, for Settings → Server
  info: ipcRenderer.sendSync('cadence-info') as ShellInfo,
});
