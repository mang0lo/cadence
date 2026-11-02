import { isMainThread } from 'node:worker_threads';

// One entry point for both roles: the HTTP server, and the import worker thread it spawns
// (new Worker(<this file>)). Keeps the production bundle a single file.
if (isMainThread) {
  const { startServer } = await import('./server');
  await startServer();
} else {
  const { runWorker } = await import('./import/worker');
  await runWorker();
}
