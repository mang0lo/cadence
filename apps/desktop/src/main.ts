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

/** Exit code of the server when it restarts itself on purpose (e.g. to apply a restored backup). */
const RESTART_EXIT_CODE = 75;

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
      log.end();
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(new Error(`The Cadence server stopped while starting (exit code ${code}). See ${logDir}.`));
      } else if (!quitting && code === RESTART_EXIT_CODE) {
        // restored backup: start again (the new server picks a new port) and reload the UI
        void startServer()
          .then((url) => {
            serverUrl = url;
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

/** Native open dialog → import the file in place, like the macOS shell. */
async function pickImportFile(): Promise<void> {
  if (!win) return;
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
    title: APP_NAME,
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
    serverUrl = process.env.CADENCE_DEV_URL || (await startServer());
    await win.loadURL(serverUrl);
    if (smoke) {
      await new Promise((r) => setTimeout(r, 4000));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(smoke, img.toPNG());
      console.log(`CADENCE_SMOKE_OK ${serverUrl} ${img.getSize().width}x${img.getSize().height}`);
      app.quit();
    }
  } catch (e) {
    dialog.showErrorBox(APP_NAME, (e as Error).message);
    app.quit();
  }
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

ipcMain.on('cadence', (_e, msg: { type?: string; filename?: string; base64?: string }) => {
  if (msg?.type === 'pickImportFile') void pickImportFile();
  else if (msg?.type === 'openDataFolder') void shell.openPath(dataDir);
  else if (msg?.type === 'saveFile' && msg.filename && msg.base64) void saveFile(msg.filename, msg.base64);
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
