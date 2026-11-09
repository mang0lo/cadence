/**
 * Cadence desktop app for Linux and Windows: the same design as the macOS shell (apps/macos), in Electron.
 *
 *  - Starts the bundled server (server/index.js) as a child process of Electron's own binary in Node mode
 *    (ELECTRON_RUN_AS_NODE; Electron ships Node 24 with node:sqlite), on a free port (PORT=0). The server announces
 *    itself on stdout as `CADENCE_LISTENING {"url","port"}` and exits when this process is gone (CADENCE_PARENT_PID).
 *  - Shows the web UI in a window; the File → Import menu and the import page use a native open dialog
 *    (preload bridge, see apps/web/src/lib/native.ts) and import the picked file in place (no upload copy).
 *  - Data lives in the per-user app data folder (Linux ~/.config/Cadence, Windows %APPDATA%\Cadence).
 *
 * CADENCE_DEV_URL=http://localhost:5173 shows a running dev server instead (npm run dev).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron';

const APP_NAME = 'Cadence';
app.setName(APP_NAME);

// CADENCE_DATA_DIR: another data folder (testing); CADENCE_DESKTOP_SMOKE=<file.png>: load, capture, quit (CI / tests)
const dataDir = process.env.CADENCE_DATA_DIR || path.join(app.getPath('appData'), APP_NAME);
const smoke = process.env.CADENCE_DESKTOP_SMOKE || null;
const logDir = path.join(dataDir, 'logs');
let server: ChildProcess | null = null;
let serverUrl: string | null = null;
let win: BrowserWindow | null = null;
let quitting = false;
/** URL of the built-in server while it runs. */
let localUrl: string | null = null;
/** The built-in server is being stopped on purpose (switched to a remote server). */
let stoppingLocal = false;

/** Exit code of the server when it restarts itself on purpose (e.g. to apply a restored backup). */
const RESTART_EXIT_CODE = 75;

/** "Cadence 0.3.0": the version in the title bar, next to the window buttons. */
const WINDOW_TITLE = `${APP_NAME} ${app.getVersion()}`;

// ---- preferences of the desktop shell (the web UI keeps everything else in the database) ----
interface DesktopPrefs {
  /** A Cadence server (e.g. Docker on a home server) to show instead of the built-in one. */
  remoteServerUrl?: string | null;
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

function startServer(): Promise<string> {
  const { entry, web } = resources();
  if (!fs.existsSync(entry)) {
    return Promise.reject(
      new Error(
        `The bundled server is missing (${entry}). Run \`npm run build\` first, or set CADENCE_DEV_URL.`,
      ),
    );
  }
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.createWriteStream(path.join(logDir, 'server.log'), { flags: 'w' });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry], {
      cwd: dataDir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CADENCE_MODE: 'desktop',
        PORT: '0',
        HOST: '127.0.0.1',
        CADENCE_DATA_DIR: dataDir,
        CADENCE_WEB_DIR: web,
        CADENCE_PARENT_PID: String(process.pid),
        NODE_ENV: 'production',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    server = child;
    let buffer = '';
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill();
      reject(new Error('The Cadence server did not start within 60 seconds.'));
    }, 60_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      log.write(chunk);
      if (resolved) return;
      buffer += chunk.toString('utf8');
      const m = /CADENCE_LISTENING (\{.*\})/.exec(buffer);
      if (m) {
        resolved = true;
        clearTimeout(timer);
        resolve((JSON.parse(m[1]!) as { url: string }).url);
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => log.write(chunk));
    child.on('exit', (code) => {
      server = null;
      localUrl = null;
      log.end();
      if (stoppingLocal) {
        stoppingLocal = false;
        return;
      }
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(new Error(`The Cadence server stopped while starting (exit code ${code}). See ${logDir}.`));
      } else if (!quitting && code === RESTART_EXIT_CODE) {
        // restored backup: start again (the new server picks a new port) and reload the UI
        void startServer()
          .then((url) => {
            serverUrl = url;
            localUrl = url;
            return win?.loadURL(url);
          })
          .catch((e: Error) => {
            dialog.showErrorBox(APP_NAME, e.message);
            app.quit();
          });
      } else if (!quitting) {
        dialog.showErrorBox(
          APP_NAME,
          `The Cadence server stopped unexpectedly (exit code ${code}). See ${logDir}.`,
        );
        app.quit();
      }
    });
  });
}

/** The built-in server's URL, starting it when it does not run. */
async function ensureLocalServer(): Promise<string> {
  if (server && localUrl) return localUrl;
  localUrl = await startServer();
  return localUrl;
}

/** Native open dialog → import the file in place, like the macOS shell. */
async function pickImportFile(): Promise<void> {
  if (!win) return;
  // a remote server cannot read files on this computer: its import page uploads the file instead
  const remote = remoteServer();
  if (remote && !process.env.CADENCE_DEV_URL) {
    await win.loadURL(`${remote}/import`).catch(() => undefined);
    return;
  }
  const r = await dialog.showOpenDialog(win, {
    title: 'Import',
    properties: ['openFile'],
    filters: [
      { name: 'Apple Health export or FIT files', extensions: ['zip', 'xml', 'fit'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  const file = r.filePaths[0];
  if (r.canceled || !file) return;
  const onImportPage = (win.webContents.getURL() ?? '').includes('/import');
  if (onImportPage) {
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('cadence:native-import', { detail: { path: ${JSON.stringify(file)} } }))`,
    );
  } else if (serverUrl) {
    await win.loadURL(`${serverUrl.replace(/\/$/, '')}/import?nativePath=${encodeURIComponent(file)}`);
  }
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        { label: '&Import…', accelerator: 'CmdOrCtrl+O', click: () => void pickImportFile() },
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
    if (!isMainFrame || !remote || code === -3 /* aborted */ || !url.startsWith(remote)) return;
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
        if (response === 0) void win?.loadURL(remote);
        else if (response === 1) void connectServer(null);
        else app.quit();
      });
  });
  // links to other sites (map attributions, COROS, docs) open in the browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (serverUrl && !url.startsWith(serverUrl)) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });

  try {
    serverUrl = process.env.CADENCE_DEV_URL || remoteServer() || (await ensureLocalServer());
    await win.loadURL(serverUrl).catch(() => undefined); // a failed load is handled by did-fail-load
    if (smoke) {
      await new Promise((r) => setTimeout(r, 4000));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(smoke, img.toPNG());
      console.log(`CADENCE_SMOKE_OK ${serverUrl} ${img.getSize().width}x${img.getSize().height}`);
      app.quit();
    }
  } catch (e) {
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
  writePrefs({ ...readPrefs(), remoteServerUrl: url });
  if (url) {
    // the built-in server is not needed while another one is shown
    if (server) {
      stoppingLocal = true;
      server.kill();
    }
    serverUrl = url;
  } else {
    serverUrl = process.env.CADENCE_DEV_URL || (await ensureLocalServer());
  }
  win.setTitle(url ? `${WINDOW_TITLE} – ${new URL(url).host}` : WINDOW_TITLE);
  await win.loadURL(serverUrl).catch(() => undefined);
}

/** Save a file the web UI made (share image): blob downloads are unreliable in embedded views, like on macOS. */
async function saveFile(filename: string, base64: string): Promise<void> {
  if (!win) return;
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), path.basename(filename)),
  });
  if (r.canceled || !r.filePath) return;
  await fs.promises.writeFile(r.filePath, Buffer.from(base64, 'base64'));
}

ipcMain.on('cadence', (_e, msg: { type?: string; filename?: string; base64?: string; url?: string }) => {
  if (msg?.type === 'pickImportFile') void pickImportFile();
  else if (msg?.type === 'openDataFolder') void shell.openPath(dataDir);
  else if (msg?.type === 'saveFile' && msg.filename && msg.base64) void saveFile(msg.filename, msg.base64);
  else if (msg?.type === 'connectServer') {
    const text = (msg.url ?? '').trim();
    const url = text ? serverUrlOf(text) : null;
    if (text && !url) return;
    void connectServer(url).catch((e: Error) => dialog.showErrorBox(APP_NAME, e.message));
  }
});

// what the web UI shows in Settings → Server (window.cadenceNative.info)
ipcMain.on('cadence-info', (e) => {
  e.returnValue = { app: 'desktop', version: app.getVersion(), remote: remoteServer() };
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
    buildMenu();
    void createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    server?.kill();
  });
}
