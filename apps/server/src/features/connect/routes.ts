/** /api/connect — activities from other watches (COROS for now). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COROS_REGIONS, type ConnectSyncProgress, type CorosStatus } from '@cadence/shared';
import { HttpError, badRequest } from '../../lib/http';
import { CorosApiError, CorosHttpError } from './coros-client';
import { CorosSync, type CorosSyncDeps } from './coros-sync';

const loginBody = z.object({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(256),
  region: z.enum(COROS_REGIONS as [string, ...string[]]),
});
const syncBody = z.object({ full: z.boolean().optional() }).optional();
const prefsBody = z.object({ autoSync: z.boolean().optional(), mobileData: z.boolean().optional() });

export interface ConnectRoutesOptions {
  /** Test seam for the COROS client (fetch, sleep, request spacing). */
  coros?: CorosSyncDeps['client'];
}

export async function connectRoutes(app: FastifyInstance, opts: ConnectRoutesOptions = {}) {
  const coros = new CorosSync({
    db: app.db,
    jobs: app.jobs,
    dataDir: app.config.dataDir,
    client: opts.coros,
  });
  app.addHook('onReady', async () => coros.startAuto());
  app.addHook('onClose', async () => coros.stop());

  app.get('/coros', async (req): Promise<CorosStatus> => coros.status(req.athleteId));

  app.post('/coros/login', async (req): Promise<CorosStatus> => {
    const b = loginBody.parse(req.body ?? {});
    if (coros.isSyncing(req.athleteId)) throw new HttpError(409, 'busy', 'A COROS sync is running');
    try {
      return await coros.connect(req.athleteId, b.email, b.password, b.region as CorosStatus['region']);
    } catch (e) {
      if (e instanceof CorosApiError) throw new HttpError(401, 'coros_login_failed', e.message);
      if (e instanceof CorosHttpError) throw new HttpError(502, 'coros_unreachable', e.message);
      throw e;
    }
  });

  app.patch('/coros', async (req): Promise<CorosStatus> => {
    const b = prefsBody.parse(req.body ?? {});
    if (!coros.status(req.athleteId).connected) throw badRequest('Not connected to COROS');
    if (b.autoSync !== undefined) coros.setAutoSync(req.athleteId, b.autoSync);
    if (b.mobileData !== undefined) coros.setMobileData(req.athleteId, b.mobileData);
    return coros.status(req.athleteId);
  });

  app.delete('/coros', async (req): Promise<CorosStatus> => {
    if (coros.isSyncing(req.athleteId)) throw new HttpError(409, 'busy', 'A COROS sync is running');
    coros.disconnect(req.athleteId);
    return coros.status(req.athleteId);
  });

  app.post('/coros/sync', async (req, reply): Promise<ConnectSyncProgress> => {
    const b = syncBody.parse(req.body ?? undefined) ?? {};
    if (!coros.status(req.athleteId).connected) throw badRequest('Not connected to COROS');
    void coros.start(req.athleteId, b.full ?? false);
    reply.code(202);
    return coros.status(req.athleteId).sync!;
  });
}
