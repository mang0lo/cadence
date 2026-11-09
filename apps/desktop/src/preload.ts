/**
 * Bridge for the web UI (apps/web/src/lib/native.ts): `window.cadenceNative.postMessage({ type })` reaches the
 * main process. The answer (a picked import file) comes back as a `cadence:native-import` window event.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cadenceNative', {
  platform: process.platform,
  postMessage: (msg: { type: string; [k: string]: unknown }) => ipcRenderer.send('cadence', msg),
  // app version and the server in use, for Settings → Server
  info: ipcRenderer.sendSync('cadence-info') as { app: 'desktop'; version: string; remote: string | null },
});
