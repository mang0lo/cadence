import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ImportJob } from '@cadence/shared';
import { invalidateStatusCounts } from '../core/routes';
import { HttpError, badRequest, notFound } from '../lib/http';
import { zDay } from '../lib/params';
import { resetAthleteData } from './reset';
import { isClinicalDocument } from './source';

const localBody = z.object({ path: z.string().min(1).max(4096) });
const rederiveBody = z
  .object({
    workoutIds: z.array(z.number().int().positive()).max(100_000).optional(),
    sinceDay: zDay.nullable().optional(),
  })
  .optional();
const resetBody = z.object({ confirm: z.literal('DELETE') });

function safeName(name: string): string {
  const base = path
    .basename(name || 'export.zip')
    .replace(/[^\w.\- ]+/g, '_')
    .slice(-120);
  return base || 'export.zip';
}

/**
 * /api/import — upload or local-path import, job list/progress, cancel, full rebuild of derived data, reset.
 * Progress of the running job: GET /api/import/jobs/:id (the web app polls it every 1.5 s while a job runs).
 */
export default async function importRoutes(app: FastifyInstance) {
  const jobs = app.jobs;

  // multipart/form-data with one file field; streamed to disk, never buffered
  app.post('/upload', async (req, reply): Promise<ImportJob> => {
    if (!req.isMultipart()) throw badRequest('Expected multipart/form-data with an export.zip file');
    const file = await req.file();
    if (!file) throw badRequest('No file in upload');
    const name = safeName(file.filename);
    if (!/\.(zip|xml|fit)$/i.test(name) || isClinicalDocument(name)) {
      file.file.resume();
      throw badRequest(
        'Upload the export.zip (or export.xml) from the Health app, or FIT files (.fit / .zip)',
      );
    }
    fs.mkdirSync(app.config.uploadsDir, { recursive: true });
    const dest = path.join(app.config.uploadsDir, `${randomUUID()}-${name}`);
    try {
      await pipeline(file.file, fs.createWriteStream(dest));
    } catch (e) {
      fs.rmSync(dest, { force: true });
      throw e;
    }
    if (file.file.truncated) {
      fs.rmSync(dest, { force: true });
      throw new HttpError(413, 'too_large', 'Upload exceeds the size limit');
    }
    const size = fs.statSync(dest).size;
    reply.code(202);
    return jobs.enqueueImport(req.athleteId, dest, {
      sourceName: name,
      sizeBytes: size,
      options: { deleteAfter: true, origin: 'upload' },
    });
  });

  // Desktop: import a file/folder from the server's own disk (the user's file is never modified)
  app.post('/local', async (req, reply): Promise<ImportJob> => {
    if (!app.config.allowLocalImport)
      throw new HttpError(403, 'forbidden', 'Local imports are disabled on this server');
    const { path: p } = localBody.parse(req.body ?? {});
    const abs = path.resolve(p.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      throw badRequest(`Not found: ${abs}`);
    }
    if (!st.isFile() && !st.isDirectory()) throw badRequest('Expected a file or folder');
    reply.code(202);
    return jobs.enqueueImport(req.athleteId, abs, {
      sourceName: path.basename(abs),
      sizeBytes: st.isFile() ? st.size : null,
      options: { deleteAfter: false, origin: 'local' },
    });
  });

  app.get<{ Querystring: { limit?: string } }>('/jobs', async (req): Promise<ImportJob[]> => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));
    return jobs.list(req.athleteId, limit);
  });

  app.get<{ Params: { id: string } }>('/jobs/:id', async (req): Promise<ImportJob> => {
    const job = jobs.get(req.athleteId, req.params.id);
    if (!job) throw notFound('Job');
    return job;
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/cancel', async (req): Promise<ImportJob> => {
    const job = jobs.cancel(req.athleteId, req.params.id);
    if (!job) throw notFound('Job');
    return job;
  });

  // Full rebuild of derived data (or a subset with workoutIds / sinceDay)
  app.post('/rederive', async (req, reply): Promise<ImportJob> => {
    const body = rederiveBody.parse(req.body ?? undefined) ?? {};
    reply.code(202);
    return jobs.enqueueDerive(req.athleteId, {
      origin: 'api',
      workoutIds: body.workoutIds ?? 'all',
      sinceDay: body.workoutIds ? (body.sinceDay ?? null) : null,
    });
  });

  // Wipe all imported + derived data of the athlete (settings are kept)
  app.post('/reset', async (req) => {
    resetBody.parse(req.body ?? {});
    if (jobs.busy(req.athleteId))
      throw new HttpError(409, 'busy', 'An import is queued or running; cancel it first');
    const deleted = resetAthleteData(app.db, req.athleteId);
    invalidateStatusCounts();
    // let feature modules clear their derived tables as well
    const job = jobs.enqueueDerive(req.athleteId, { origin: 'reset', workoutIds: 'all', sinceDay: null });
    return { ok: true, deleted, job };
  });
}
