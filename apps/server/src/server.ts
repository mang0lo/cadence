import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { LISTENING_PREFIX, RESTART_EXIT_CODE } from '@cadence/shared';
import { buildApp, migrateAll } from './app';
import { isLoopbackHost, loadConfig } from './config';
import { openWithPendingRestore } from './core/backup-routes';
import { openDb } from './db/db';

export async function startServer(): Promise<void> {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = openWithPendingRestore(config.dbPath, (file) => {
    const db = openDb(file);
    try {
      migrateAll(db);
      return db;
    } catch (e) {
      db.close();
      throw e;
    }
  });

  const app = await buildApp(config, db);
  await app.listen({ host: config.host, port: config.port });
  const { port } = app.server.address() as AddressInfo;
  const anyHost = config.host === '0.0.0.0' || config.host === '::';
  const url = `http://${anyHost ? 'localhost' : config.host.includes(':') ? `[${config.host}]` : config.host}:${port}`;
  // Machine readable line: the desktop shells read the port we listen on from here (packages/shared/src/shell.ts).
  console.log(`${LISTENING_PREFIX}${JSON.stringify({ url, port })}`);
  if (config.mode !== 'desktop') {
    const where = anyHost ? `  (all network interfaces, ${config.host}:${port})` : '';
    console.log(`Cadence ${config.version} (${config.mode}) → ${url}${where}  data: ${config.dataDir}`);
  }
  if (!config.password && !isLoopbackHost(config.host)) {
    console.warn(
      `WARNING: Cadence listens on ${config.host}:${port} without a password. Everyone who can reach this port can ` +
        'read, change and delete all data. Set CADENCE_PASSWORD, or HOST=127.0.0.1 to stay on this machine.',
    );
  }

  let closing = false;
  const shutdown = async (code = 0) => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
    } finally {
      db.close();
      process.exit(code);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  // A restored backup is applied on the next start; the exit code tells the shell / Docker to restart us.
  process.on('SIGUSR2', () => void shutdown(RESTART_EXIT_CODE));
  if (config.parentPid) {
    setInterval(() => {
      try {
        process.kill(config.parentPid!, 0);
      } catch {
        void shutdown();
      }
    }, 2000).unref();
  }
}
