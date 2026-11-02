import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { buildApp, migrateAll } from './app';
import { loadConfig } from './config';
import { applyPendingRestore, RESTART_EXIT_CODE } from './core/backup-routes';
import { openDb } from './db/db';

export async function startServer(): Promise<void> {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (applyPendingRestore(config.dbPath)) console.log('Restored the database from an uploaded backup');
  const db = openDb(config.dbPath);
  migrateAll(db);

  const app = await buildApp(config, db);
  await app.listen({ host: config.host, port: config.port });
  const { port } = app.server.address() as AddressInfo;
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`;
  // Machine readable line: the macOS shell starts us with PORT=0 and reads the chosen port from here.
  console.log(`CADENCE_LISTENING ${JSON.stringify({ url, port })}`);
  if (config.mode !== 'desktop') console.log(`Cadence ${config.version} (${config.mode}) → ${url}  data: ${config.dataDir}`);

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
