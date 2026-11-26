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
  /**
   * Reverse proxies whose X-Forwarded-For / -Proto / -Host headers are believed (CADENCE_TRUST_PROXY): their
   * addresses or networks ('127.0.0.1', '172.16.0.0/12', 'loopback', 'uniquelocal', comma separated), or true for
   * every peer. Off by default: client address (login throttle) and https (Secure cookie) come from the socket.
   */
  trustProxy: boolean | string;
  /**
   * Host names the server answers to besides localhost and IP addresses (CADENCE_ALLOWED_HOSTS, '.example.org'
   * includes subdomains); null = any. Password-less local servers only answer to local names (DNS rebinding).
   */
  allowedHosts: string[] | null;
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
// tsx runs the TypeScript sources, the bundle is one .js file (a checkout under ~/src/… is no source run)
const fromSource = import.meta.url.endsWith('.ts');

/** 127.0.0.1, ::1, localhost: an address only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function trustProxyFrom(value: string | undefined): boolean | string {
  const v = (value ?? '').trim();
  if (!v || /^(0|false|no|off)$/i.test(v)) return false;
  if (/^(true|yes|on|all)$/i.test(v)) return true;
  // Fastify never trusts a bare hop count (it cannot tell the proxy from a direct client)
  if (/^\d+$/.test(v))
    throw new Error(`CADENCE_TRUST_PROXY=${v}: give the proxy's address or network (e.g. 127.0.0.1, 172.16.0.0/12, loopback) or true`);
  return v;
}

function allowedHostsFrom(value: string | undefined, mode: Mode, host: string, password: string | null): string[] | null {
  const v = (value ?? '').trim();
  if (v === '*') return null;
  if (v) return v.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  // without a password a local server is only safe from web pages when it ignores foreign host names
  return mode !== 'server' || (!password && isLoopbackHost(host)) ? [] : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode: Mode =
    env.CADENCE_MODE === 'desktop' || env.CADENCE_MODE === 'server' || env.CADENCE_MODE === 'dev'
      ? env.CADENCE_MODE
      : fromSource
        ? 'dev'
        : 'server';
  const dataDir = path.resolve(env.CADENCE_DATA_DIR ?? path.join(appsDir, '..', 'data'));
  const password = env.CADENCE_PASSWORD || null;
  // a server without a password stays on this machine unless HOST says otherwise (Docker sets HOST=0.0.0.0)
  const host = env.HOST ?? (mode === 'server' && password ? '0.0.0.0' : '127.0.0.1');
  return {
    mode,
    host,
    port: env.PORT !== undefined ? Number(env.PORT) : 8787,
    dataDir,
    dbPath: path.join(dataDir, 'cadence.db'),
    uploadsDir: path.join(dataDir, 'uploads'),
    webDir: path.resolve(env.CADENCE_WEB_DIR ?? path.join(appsDir, 'web', 'dist')),
    password,
    trustProxy: trustProxyFrom(env.CADENCE_TRUST_PROXY),
    allowedHosts: allowedHostsFrom(env.CADENCE_ALLOWED_HOSTS, mode, host, password),
    allowLocalImport: env.CADENCE_ALLOW_LOCAL_IMPORT ? env.CADENCE_ALLOW_LOCAL_IMPORT === '1' : mode !== 'server',
    importWatchDir: env.CADENCE_IMPORT_DIR ? path.resolve(env.CADENCE_IMPORT_DIR) : null,
    parentPid: env.CADENCE_PARENT_PID ? Number(env.CADENCE_PARENT_PID) : null,
    logLevel: env.LOG_LEVEL ?? (mode === 'dev' ? 'info' : 'warn'),
    version: typeof __CADENCE_VERSION__ === 'string' ? __CADENCE_VERSION__ : '0.1.0-dev',
  };
}
