import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Mode = 'dev' | 'desktop' | 'server';

export interface Config {
  mode: Mode;
  host: string;
  /** 0 lets the OS pick a free port (used by the macOS shell). */
  port: number;
  dataDir: string;
  dbPath: string;
  uploadsDir: string;
  /** Directory with the built web UI (apps/web/dist). Served with an SPA fallback when it exists. */
  webDir: string;
  /** Optional shared password for server deployments. When set, every /api request must be authenticated. */
  password: string | null;
  /** Allow POST /api/import/local {path} (reads a file from the server's own disk). Desktop only by default. */
  allowLocalImport: boolean;
  /** Optional folder that is watched for new Apple Health exports (server deployments). */
  importWatchDir: string | null;
  /** When set, the server exits once this process id is gone (the macOS shell passes its pid). */
  parentPid: number | null;
  logLevel: string;
  version: string;
}

declare const __CADENCE_VERSION__: string | undefined;

const here = path.dirname(fileURLToPath(import.meta.url));
// Both apps/server/src (tsx) and apps/server/dist (bundle) sit two levels below apps/.
const appsDir = path.resolve(here, '..', '..');
const fromSource = here.endsWith(`${path.sep}src`) || here.includes(`${path.sep}src${path.sep}`);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode: Mode =
    env.CADENCE_MODE === 'desktop' || env.CADENCE_MODE === 'server' || env.CADENCE_MODE === 'dev'
      ? env.CADENCE_MODE
      : fromSource
        ? 'dev'
        : 'server';
  const dataDir = path.resolve(env.CADENCE_DATA_DIR ?? path.join(appsDir, '..', 'data'));
  return {
    mode,
    host: env.HOST ?? (mode === 'server' ? '0.0.0.0' : '127.0.0.1'),
    port: env.PORT !== undefined ? Number(env.PORT) : 8787,
    dataDir,
    dbPath: path.join(dataDir, 'cadence.db'),
    uploadsDir: path.join(dataDir, 'uploads'),
    webDir: path.resolve(env.CADENCE_WEB_DIR ?? path.join(appsDir, 'web', 'dist')),
    password: env.CADENCE_PASSWORD || null,
    allowLocalImport: env.CADENCE_ALLOW_LOCAL_IMPORT ? env.CADENCE_ALLOW_LOCAL_IMPORT === '1' : mode !== 'server',
    importWatchDir: env.CADENCE_IMPORT_DIR ? path.resolve(env.CADENCE_IMPORT_DIR) : null,
    parentPid: env.CADENCE_PARENT_PID ? Number(env.CADENCE_PARENT_PID) : null,
    logLevel: env.LOG_LEVEL ?? (mode === 'dev' ? 'info' : 'warn'),
    version: typeof __CADENCE_VERSION__ === 'string' ? __CADENCE_VERSION__ : '0.1.0-dev',
  };
}
