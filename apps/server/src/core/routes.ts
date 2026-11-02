import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AthleteSettings, ServerStatus } from '@cadence/shared';
import { get, run } from '../db/db';
import { isAuthenticated } from './auth';
import { getAthlete, getSettings, updateSettings } from './settings';

let countsCache: { at: number; value: ServerStatus['counts'] } | null = null;

const settingsPatch = z
  .object({
    units: z.enum(['metric', 'imperial']),
    language: z.enum(['auto', 'de', 'en']),
    theme: z.enum(['system', 'light', 'dark']),
    mapStyle: z.enum(['streets', 'outdoor', 'satellite', 'dark']),
    weekStart: z.union([z.literal(0), z.literal(1)]),
    maxHr: z.number().int().min(100).max(240).nullable(),
    restingHr: z.number().int().min(25).max(120).nullable(),
    hrZoneMethod: z.enum(['maxhr', 'hrr', 'custom']),
    hrZones: z.array(z.number().int().min(40).max(240)).length(4).nullable(),
    ftp: z.number().int().min(50).max(600).nullable(),
    sex: z.enum(['male', 'female', 'other']).nullable(),
    birthDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    privacyZones: z.array(
      z.object({
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        radiusM: z.number().min(50).max(5000),
        label: z.string().max(60).optional(),
      }),
    ),
  })
  .partial();

/** Core endpoints: status, athlete profile, settings. Mounted under /api. */
export default async function coreRoutes(app: FastifyInstance) {
  app.get('/status', async (req): Promise<ServerStatus & { authenticated: boolean }> => {
    const db = app.db;
    if (!countsCache || Date.now() - countsCache.at > 30_000) {
      const workouts = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM workouts')!.n;
      const recordTypes = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM record_types')!.n;
      const records = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM records')!.n;
      countsCache = { at: Date.now(), value: { workouts, records, recordTypes } };
    }
    const last = get<{ t: number | null }>(
      db,
      "SELECT MAX(finished_at) AS t FROM import_jobs WHERE status = 'done' AND kind = 'import'",
    );
    return {
      ok: true,
      name: 'cadence',
      version: app.config.version,
      mode: app.config.mode,
      authRequired: !!app.config.password,
      authenticated: isAuthenticated(req, app.config.password),
      localImport: app.config.allowLocalImport,
      counts: countsCache.value,
      lastImportAt: last?.t ?? null,
    };
  });

  app.get('/athlete', async (req) => getAthlete(app.db, req.athleteId));

  app.patch<{ Body: { name?: string } }>('/athlete', async (req) => {
    const name = z.string().trim().min(1).max(80).parse(req.body?.name);
    run(app.db, 'UPDATE athletes SET name = ?, updated_at = unixepoch() WHERE id = ?', [name, req.athleteId]);
    return getAthlete(app.db, req.athleteId);
  });

  app.get('/settings', async (req): Promise<AthleteSettings> => getSettings(app.db, req.athleteId));

  app.patch('/settings', async (req): Promise<AthleteSettings> => {
    const patch = settingsPatch.parse(req.body ?? {});
    return updateSettings(app.db, req.athleteId, patch as Partial<AthleteSettings>);
  });
}

/** Lets other modules invalidate the cached counts (e.g. after an import). */
export function invalidateStatusCounts(): void {
  countsCache = null;
}
