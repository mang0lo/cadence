import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import compress from '@fastify/compress';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { Config } from './config';
import type { Db } from './db/db';
import { migrate } from './db/migrate';
import { coreMigrations } from './db/schema';
import { registerAuth } from './core/auth';
import backupRoutes from './core/backup-routes';
import coreRoutes from './core/routes';
import metricsRoutes from './core/metrics-routes';
import workoutRoutes from './core/workouts-routes';
import { JobManager, type JobRunnerMode } from './import/jobs';
import importRoutes from './import/routes';
import { startImportWatcher } from './import/watch';
import { features } from './features';

/** Core schema first, then every feature's migrations in registration order. */
export function migrateAll(db: Db): string[] {
  return migrate(db, [...coreMigrations, ...features.flatMap((f) => f.migrations ?? [])]);
}

export interface BuildAppOptions {
  /** 'worker' (default) runs imports in a worker thread; 'inline' on the main thread (tests). */
  jobRunner?: JobRunnerMode;
}

export async function buildApp(config: Config, db: Db, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  // Request logs are emitted at 'info'; desktop/server default to 'warn', so they only show in dev.
  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: 25 * 1024 * 1024,
    // opt-in (CADENCE_TRUST_PROXY): client address and https from the proxy's X-Forwarded-* headers
    trustProxy: config.trustProxy,
  });

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorateRequest('athleteId', 1);

  const jobs = new JobManager(db, config, opts.jobRunner ?? 'worker');
  app.decorate('jobs', jobs);
  let stopWatcher: (() => void) | null = null;
  app.addHook('onReady', async () => {
    jobs.start();
    if (config.importWatchDir) stopWatcher = startImportWatcher(db, jobs, config.importWatchDir);
  });
  app.addHook('onClose', async () => {
    stopWatcher?.();
    await jobs.close();
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    const status = e.statusCode && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) req.log.error(err);
    return reply
      .code(status)
      .send({ error: { code: typeof e.code === 'string' ? e.code : 'error', message: e.message ?? 'Unexpected error' } });
  });

  // Baseline browser protections: no MIME sniffing, no embedding in other sites, no activity URLs in referrers.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'SAMEORIGIN');
    reply.header('content-security-policy', "frame-ancestors 'self'");
    reply.header('referrer-policy', 'same-origin');
  });

  await app.register(compress, { global: true, threshold: 2048 });
  await app.register(multipart, { limits: { fileSize: 64 * 1024 ** 3, files: 1 } });
  // Host / Origin / password checks: on the root, before any route, so every route below inherits them
  registerAuth(app, config);

  await app.register(coreRoutes, { prefix: '/api' });
  await app.register(workoutRoutes, { prefix: '/api' });
  await app.register(metricsRoutes, { prefix: '/api' });
  await app.register(backupRoutes, { prefix: '/api' });
  await app.register(importRoutes, { prefix: '/api/import' });
  for (const feature of features) {
    if (feature.routes) await app.register(feature.routes, { prefix: `/api/${feature.name}` });
  }

  const hasWeb = fs.existsSync(path.join(config.webDir, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      index: ['index.html'],
      wildcard: false,
      // Vite's files in /assets carry a content hash: cache them for good; everything else is revalidated,
      // so an update of the app is picked up on the next load
      cacheControl: false,
      setHeaders: (res, file) => {
        res.header(
          'cache-control',
          /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    if (hasWeb && req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: { code: 'not_found', message: `${req.method} ${req.url} not found` } });
  });

  return app;
}
