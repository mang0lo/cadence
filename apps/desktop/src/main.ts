/**
 * Cadence desktop app for Linux and Windows: the same design as the macOS shell (apps/macos), in Electron.
 *
 *  - Starts the bundled server (server/index.js) as a child process of Electron's own binary in Node mode
 *    (ELECTRON_RUN_AS_NODE; Electron ships Node 24 with node:sqlite), see server-process.ts. It keeps the port of
 *    the last launch (desktop.json), so the page keeps its origin and with it its browser storage.
 *  - Shows the web UI in a window; the File → Import menu and the import page use a native open dialog
 *    (preload bridge, see apps/web/src/lib/native.ts) and import the picked file in place (no upload copy).
 *  - Data lives in the per-user app data folder (Linux ~/.config/Cadence, Windows %APPDATA%\Cadence).
 *
 * CADENCE_DEV_URL=http://localhost:5173 shows a running dev server instead (npm run dev).
 */
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type MenuItemConstructorOptions } from 'electron';
import { importDialogOptions, type ImportPick } from './import-picker';
import { allowsPermission, isAppFrame, isAppUrl, isExternalUrl, navigationTarget, originOf } from './policy';
import { DEFAULT_PORT, LocalServer, ServerStopped } from './server-process';
import {
  cancelledEventScript,
  importEventScript,
  parseBridgeMessage,
  savedFileName,
  shellInfo,
  type NativeMessage,
} from './shell-contract';

const APP_NAME = 'Cadence';
app.setName(APP_NAME);

// CADENCE_DATA_DIR: another data folder (testing); CADENCE_DESKTOP_SMOKE=<file.png>: load, capture, quit (CI / tests)
const dataDir = process.env.CADENCE_DATA_DIR || path.join(app.getPath('appData'), APP_NAME);
const smoke = process.env.CADENCE_DESKTOP_SMOKE || null;
const logDir = path.join(dataDir, 'logs');
let serverUrl: string | null = null;
/** The origins of the server's pages (policy.ts): its URL's, and where the server sent the app's own load. */
let appOrigins: string[] = [];
let win: BrowserWindow | null = null;
let quitting = false;

/** "Cadence 0.3.0": the version in the title bar, next to the window buttons. */
const WINDOW_TITLE = `${APP_NAME} ${app.getVersion()}`;

// ---- preferences of the desktop shell (the web UI keeps everything else in the database) ----
interface DesktopPrefs {
  /** A Cadence server (e.g. Docker on a home server) to show instead of the built-in one. */
  remoteServerUrl?: string | null;
  /** The port the built-in server listened on last time (the page's origin, and so its browser storage, depend on it). */
  port?: number;
}
const prefsFile = path.join(dataDir, 'desktop.json');
function readPrefs(): DesktopPrefs {
  try {
    return JSON.parse(fs.readFileSync(prefsFile, 'utf8')) as DesktopPrefs;
  } catch {
    return {};
  }
}
function writePrefs(p: DesktopPrefs): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(prefsFile, JSON.stringify(p, null, 2));
}
/** http(s) URL with a host, normalized without a trailing slash; null otherwise. */
function serverUrlOf(text: string): string | null {
  try {
    const u = new URL(text.includes('://') ? text : `http://${text}`);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}
const remoteServer = (): string | null => serverUrlOf(readPrefs().remoteServerUrl ?? '');
/** The window shows the built-in server (or the dev server): it can import files on this computer in place. */
const importsLocally = (): boolean => !!process.env.CADENCE_DEV_URL || !remoteServer();

/** server/index.js and the web UI: inside the package (resources) or, unpackaged, from the repo's build output. */
function resources(): { entry: string; web: string } {
  if (app.isPackaged) {
    return {
      entry: path.join(process.resourcesPath, 'server', 'index.js'),
      web: path.join(process.resourcesPath, 'web'),
    };
  }
  const apps = path.resolve(__dirname, '..', '..');
  return { entry: path.join(apps, 'server', 'dist', 'index.js'), web: path.join(apps, 'web', 'dist') };
}

const localServer = new LocalServer({
  execPath: process.execPath,
  entry: resources().entry,
  webDir: resources().web,
  dataDir,
  logDir,
  env: { ELECTRON_RUN_AS_NODE: '1' },
  preferredPort: () => {
    const port = readPrefs().port;
    return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
  },
  onPort: (port) => {
    const prefs = readPrefs();
    if (prefs.port !== port) writePrefs({ ...prefs, port });
  },
});
// restored backup: the server stops itself; start it again (same port: the page keeps its origin) and reload the UI
localServer.on('restart', () => {
  if (quitting) return;
  localServer
    .start()
    // the page reloads itself as soon as the server answers again (BackupSection): either load may abort the other
    .then((url) => loadApp(url))
    .catch((e: Error) => {
      if (e instanceof ServerStopped) return;
      dialog.showErrorBox(APP_NAME, e.message);
      app.quit();
    });
});
localServer.on('crash', (code) => {
  if (quitting) return;
  const message = `The Cadence server stopped unexpectedly (exit code ${code}). See ${logDir}.`;
  if (smoke) {
    // no dialog in tests: it would wait forever (like the Mac app's smoke run, fail at once)
    console.error(`CADENCE_SMOKE_FAILED ${message}`);
    app.exit(1);
    return;
  }
  dialog.showErrorBox(APP_NAME, message);
  app.quit();
});

/** Shows the Cadence server at `url` in the window. A failed load is handled by did-fail-load. */
async function loadApp(url: string): Promise<void> {
  serverUrl = url;
  const origin = originOf(url);
  appOrigins = origin ? [origin] : [];
  if (!win) return;
  await win.loadURL(url).catch(() => undefined);
  // the server may have sent the app elsewhere (e.g. from http to https): the page there is the app as well
  const landed = originOf(win?.webContents.getURL());
  if (serverUrl === url && landed && !appOrigins.includes(landed)) appOrigins = [...appOrigins, landed];
}

/** The built-in server's URL, starting it when it does not run. `keep`: a remote server that was just left. */
async function ensureLocalServer(keep: string | null = null): Promise<string> {
  const firstOnLastingPort = readPrefs().port === undefined;
  const url = await localServer.ensure();
  // The browser profile always stays in the app data folder. With CADENCE_DATA_DIR (smoke runs, tests) desktop.json is
  // not that profile's, and what the profile keeps belongs to the app's own launches: nothing to remove.
  if (firstOnLastingPort && !process.env.CADENCE_DATA_DIR) {
    await forgetOldLocalOrigins([remoteServer(), keep]);
  }
  return url;
}

/**
 * Until the built-in server kept its port, every launch gave the page a new origin (http://127.0.0.1:<port>) and
 * left what it had stored under the old one behind for good. Removes that once, before the page first loads on its
 * lasting port. The storage of remote servers (`keep`), every cookie and the HTTP cache (map tiles, keyed by site
 * and not by port) stay.
 */
async function forgetOldLocalOrigins(keep: (string | null)[]): Promise<void> {
  const origins = keep.flatMap((u) => (u ? [new URL(u).origin] : []));
  await session.defaultSession
    .clearData({
      dataTypes: ['backgroundFetch', 'fileSystems', 'indexedDB', 'localStorage', 'serviceWorkers', 'webSQL'],
      ...(origins.length ? { excludeOrigins: origins } : {}),
    })
    .catch(() => undefined);
}

/** A path to import that waits for the import page, which asks for it once it listens (importReady). */
let pendingImport: string | null = null;

/**
 * Native open dialog (a file, or a folder) → import it in place, like the macOS shell. An open import page imports
 * the path at once; otherwise the app opens the import page, which asks for the path (importReady) and shows it for
 * confirmation. No URL carries the path, so no link from elsewhere can start a local import.
 */
async function pickImportFile(pick: ImportPick = 'file'): Promise<void> {
  if (!win) return;
  // a remote server cannot read files on this computer: its import page uploads the file instead
  const remote = remoteServer();
  if (remote && !process.env.CADENCE_DEV_URL) {
    await win.loadURL(`${remote}/import`).catch(() => undefined);
    return;
  }
  const r = await dialog.showOpenDialog(win, importDialogOptions(pick));
  const file = r.filePaths[0];
  if (r.canceled || !file || !win) return;
  pendingImport = file;
  // only the app's own page may learn the path (policy.ts): another site in the window makes way for /import
  const handled =
    isAppUrl(win.webContents.getURL(), appOrigins) &&
    (await win.webContents.executeJavaScript(importEventScript({ path: file })).catch(() => false)) === true;
  if (handled) {
    if (pendingImport === file) pendingImport = null; // the open import page took it
  } else if (serverUrl) {
    await win.loadURL(`${serverUrl.replace(/\/$/, '')}/import`).catch(() => undefined);
  }
}

/** importReady: the import page listens now and gets the path that waited for it. */
function handOverPendingImport(): void {
  const path = pendingImport;
  pendingImport = null;
  if (!path || !win || !importsLocally()) return;
  void win.webContents.executeJavaScript(importEventScript({ path, confirm: true })).catch(() => undefined);
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        { label: '&Import…', accelerator: 'CmdOrCtrl+O', click: () => void pickImportFile() },
        // an unzipped export or a folder of FIT files: the file dialog cannot pick folders on Windows and Linux
        { label: 'Import &folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => void pickImportFile('folder') },
        { label: 'Open &data folder', click: () => void shell.openPath(dataDir) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Server log', click: () => void shell.openPath(path.join(logDir, 'server.log')) },
        { label: `${APP_NAME} ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** The rendered app shell (sidebar navigation and main area): not a blank page, an error page or the login page. */
const SMOKE_READY = "!!document.querySelector('aside nav a[href]') && !!document.querySelector('main')";

/** Smoke test: rejects as soon as the page fails to load, answers with an error status or its renderer crashes. */
function smokeFailures(w: BrowserWindow): Promise<never> {
  const failures = new Promise<never>((_, reject) => {
    w.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3 /* aborted */) reject(new Error(`${url} did not load: ${description} (${code})`));
    });
    w.webContents.on('did-navigate', (_e, url, httpResponseCode) => {
      if (httpResponseCode >= 400) reject(new Error(`${url} answered with HTTP ${httpResponseCode}`));
    });
    w.webContents.on('render-process-gone', (_e, details) => reject(new Error(`the page crashed (${details.reason})`)));
  });
  failures.catch(() => undefined); // awaited later (smokeReady)
  return failures;
}

/** Smoke test: waits until the app shell rendered (at most 60 s), unless the page failed before. */
async function smokeReady(w: BrowserWindow, failures: Promise<never>): Promise<void> {
  const deadline = Date.now() + 60_000;
  const rendered = (async () => {
    while (!(await w.webContents.executeJavaScript(SMOKE_READY).catch(() => false))) {
      if (Date.now() > deadline) throw new Error('the app did not render within 60 seconds');
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  await Promise.race([rendered, failures]);
  await new Promise((r) => setTimeout(r, 1500)); // the first page draws its content for the screenshot
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: WINDOW_TITLE,
    backgroundColor: '#f6f7f4',
    icon: path.join(__dirname, '..', 'resources', 'icon.png'),
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => {
    if (!smoke) win?.show();
  });
  win.on('closed', () => (win = null));
  // keep "Cadence <version>" instead of the page's <title>
  win.on('page-title-updated', (e) => {
    e.preventDefault();
    const remote = remoteServer();
    win?.setTitle(remote ? `${WINDOW_TITLE} – ${new URL(remote).host}` : WINDOW_TITLE);
  });
  // a remote server that does not answer: try again or go back to the built-in one
  win.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    const remote = remoteServer();
    if (!isMainFrame || !remote || serverUrl !== remote || code === -3 /* aborted */ || !isAppUrl(url, appOrigins)) {
      return;
    }
    void dialog
      .showMessageBox(win!, {
        type: 'warning',
        title: APP_NAME,
        message: `${new URL(remote).host} is not reachable`,
        detail: description,
        buttons: ['Try again', 'Use built-in server', 'Quit'],
        defaultId: 0,
        cancelId: 2,
      })
      .then(({ response }) => {
        if (response === 0) void loadApp(remote);
        else if (response === 1) void connectServer(null);
        else app.quit();
      });
  });
  // links to other sites (map attributions, COROS, docs) open in the browser; other schemes never reach the OS
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const target = navigationTarget(url, appOrigins);
    if (target === 'app') return;
    e.preventDefault();
    if (target === 'external') void shell.openExternal(url);
  });

  // CADENCE_DESKTOP_SMOKE (CI): the screenshot is written only when the page loaded and the app shell rendered
  const failures = smoke ? smokeFailures(win) : null;
  try {
    await loadApp(process.env.CADENCE_DEV_URL || remoteServer() || (await ensureLocalServer()));
    if (smoke && failures) {
      await smokeReady(win, failures);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(smoke, img.toPNG());
      console.log(`CADENCE_SMOKE_OK ${serverUrl} ${img.getSize().width}x${img.getSize().height}`);
      app.quit();
    }
  } catch (e) {
    if (e instanceof ServerStopped) return; // replaced by another start (e.g. Settings → Server)
    if (smoke) {
      // no dialog in tests: it would wait forever
      console.error(`CADENCE_SMOKE_FAILED ${(e as Error).message}`);
      app.exit(1);
      return;
    }
    dialog.showErrorBox(APP_NAME, (e as Error).message);
    app.quit();
  }
}

/** Settings → Server: show another Cadence server (null = the built-in one, started again when needed). */
async function connectServer(url: string | null): Promise<void> {
  if (!win) return;
  pendingImport = null; // a path picked for the server shown so far is not for the next one
  const previous = remoteServer();
  writePrefs({ ...readPrefs(), remoteServerUrl: url });
  // the built-in server is not needed while another one is shown
  if (url) void localServer.stop();
  const next = url ?? (process.env.CADENCE_DEV_URL || (await ensureLocalServer(previous)));
  win.setTitle(url ? `${WINDOW_TITLE} – ${new URL(url).host}` : WINDOW_TITLE);
  await loadApp(next);
}

/**
 * Settings → Server asks to show another server from now on: the user confirms it here, in a dialog no page can
 * draw, so a page cannot switch the app to a server of its choosing. Going back to the built-in server needs none.
 */
async function confirmServer(url: string | null): Promise<boolean> {
  if (!url || !win) return !!win;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: APP_NAME,
    message: `Show the Cadence server at ${new URL(url).host}?`,
    detail:
      `From now on, ${APP_NAME} shows ${url} instead of the server built into the app.` +
      (url.startsWith('http:') ? ' The connection to it is not encrypted (http): use it only on a network you trust.' : ''),
    buttons: ['Connect', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
}

/** The user cancelled what message `type` asked for: the page that waits for the answer stops waiting. */
function tellCancelled(type: NativeMessage['type']): void {
  void win?.webContents.executeJavaScript(cancelledEventScript(type)).catch(() => undefined);
}

/**
 * Save a file the web UI made (share image, CSV export): blob downloads are unreliable in embedded views, like on
 * macOS. The dialog suggests the name the page gave; only images and data exports are accepted (savedFileName).
 */
async function saveFile(filename: string, base64: string): Promise<void> {
  const name = savedFileName(filename);
  if (!name) return shell.beep();
  if (!win) return;
  const type = path.extname(name).slice(1).toLowerCase();
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), name),
    filters: [{ name: type.toUpperCase(), extensions: [type] }],
  });
  if (r.canceled || !r.filePath) return;
  await fs.promises.writeFile(r.filePath, Buffer.from(base64, 'base64'));
}

ipcMain.on('cadence', (event, raw: unknown) => {
  // only the app's own page reaches the bridge, not another site that ended up in the window (policy.ts)
  if (!win || event.sender !== win.webContents || !isAppFrame(event.senderFrame, appOrigins)) return;
  const msg = parseBridgeMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case 'pickImportFile':
      void pickImportFile(msg.folder ? 'folder' : 'file');
      break;
    case 'importReady':
      handOverPendingImport();
      break;
    case 'openDataFolder':
      void shell.openPath(dataDir);
      break;
    case 'saveFile':
      void saveFile(msg.filename, msg.base64);
      break;
    case 'connectServer': {
      const text = msg.url.trim();
      const url = text ? serverUrlOf(text) : null;
      if (text && !url) return tellCancelled('connectServer');
      void confirmServer(url)
        .then((ok) => {
          if (ok) return connectServer(url);
          tellCancelled('connectServer'); // the page waits for the switch
        })
        .catch((e: Error) => {
          if (!(e instanceof ServerStopped)) dialog.showErrorBox(APP_NAME, e.message);
        });
      break;
    }
    default:
      msg satisfies never;
  }
});

// what the web UI shows in Settings → Server (window.cadenceNative.info)
ipcMain.on('cadence-info', (e) => {
  e.returnValue = shellInfo('desktop', app.getVersion(), remoteServer());
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    fs.mkdirSync(dataDir, { recursive: true });
    // camera, microphone, location, notifications, opening other apps …: only what the app's own pages use
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) =>
      callback(allowsPermission(permission, details.requestingUrl, appOrigins)),
    );
    session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
      allowsPermission(permission, requestingOrigin, appOrigins),
    );
    buildMenu();
    void createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    void localServer.stop();
  });
}
