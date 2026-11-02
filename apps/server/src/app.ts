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

  await app.register(compress, { global: true, threshold: 2048 });
  await app.register(multipart, { limits: { fileSize: 64 * 1024 ** 3, files: 1 } });
  registerAuth(app, config.password);

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
    await app.register(fastifyStatic, { root: config.webDir, index: ['index.html'], wildcard: false });
  }
  app.setNotFoundHandler((req, reply) => {
    if (hasWeb && req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: { code: 'not_found', message: `${req.method} ${req.url} not found` } });
  });

  return app;
}
