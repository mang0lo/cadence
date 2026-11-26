import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AthleteSettings, DataSourcesInfo, ServerStatus } from '@cadence/shared';
import { get, run, type Db } from '../db/db';
import { isAuthenticated } from './auth';
import { getAthlete, getSettings, updateSettings } from './settings';
import { dataSources, preferred } from './sources';

/** Per athlete: the counts are cheap but not free, and /status is polled. */
const countsCache = new Map<number, { at: number; value: ServerStatus['counts'] }>();

function statusCounts(db: Db, athleteId: number): ServerStatus['counts'] {
  const hit = countsCache.get(athleteId);
  if (hit && Date.now() - hit.at <= 30_000) return hit.value;
  // record_type_stats instead of COUNT(*) over records: tens of millions of rows would block the event loop
  const workouts = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM workouts WHERE athlete_id = ?', [athleteId])!.n;
  const r = get<{ types: number; records: number | null }>(
    db,
    'SELECT COUNT(*) AS types, SUM(count) AS records FROM record_type_stats WHERE athlete_id = ?',
    [athleteId],
  )!;
  const value = { workouts, records: r.records ?? 0, recordTypes: r.types };
  countsCache.set(athleteId, { at: Date.now(), value });
  return value;
}

const settingsPatch = z
  .object({
    units: z.enum(['metric', 'imperial']),
    language: z.enum(['auto', 'de', 'en']),
    theme: z.enum(['system', 'light', 'dark']),
    mapStyle: z.enum(['streets', 'outdoor', 'satellite', 'dark']),
    thumbnailMaps: z.boolean(),
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
    watch: z.enum(['apple', 'coros', 'other']),
    sources: z.object({
      workouts: z.enum(['auto', 'apple', 'device']),
      heart: z.enum(['auto', 'apple', 'device']),
    }),
    navOrder: z.array(z.string().min(1).max(120).startsWith('/')).max(200),
    navGroups: z.array(z.string().min(1).max(40)).max(20),
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
  // Public (login screen, Docker health check): before a login it tells nothing about the data or the version
  app.get('/status', { config: { public: true } }, async (req): Promise<ServerStatus & { authenticated: boolean }> => {
    const authRequired = !!app.config.password;
    const authenticated = isAuthenticated(req, app.config.password);
    const base = { ok: true as const, name: 'cadence' as const, mode: app.config.mode, authRequired, authenticated };
    if (authRequired && !authenticated) {
      return { ...base, version: '', localImport: false, counts: { workouts: 0, records: 0, recordTypes: 0 }, lastImportAt: null };
    }
    const last = get<{ t: number | null }>(
      app.db,
      "SELECT MAX(finished_at) AS t FROM import_jobs WHERE athlete_id = ? AND status = 'done' AND kind = 'import'",
      [req.athleteId],
    );
    return {
      ...base,
      version: app.config.version,
      localImport: app.config.allowLocalImport,
      counts: statusCounts(app.db, req.athleteId),
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

  // Which watch, which sources have data and which metrics exist (pages hide what cannot have data)
  app.get('/sources', async (req): Promise<DataSourcesInfo> => dataSources(app.db, req.athleteId));

  app.patch('/settings', async (req): Promise<AthleteSettings> => {
    const patch = settingsPatch.parse(req.body ?? {});
    const before = getSettings(app.db, req.athleteId);
    const next = updateSettings(app.db, req.athleteId, patch as Partial<AthleteSettings>);
    // HR settings change zones and relative effort: recompute them in the background (cheap, histogram based)
    const changed = (k: keyof AthleteSettings) => JSON.stringify(before[k]) !== JSON.stringify(next[k]);
    const workoutSource =
      preferred(before, 'workouts') !== preferred(next, 'workouts') && app.jobs !== undefined;
    if (workoutSource) {
      // another copy of overlapping workouts wins now: duplicates and every total built on them change
      app.jobs.enqueueDerive(req.athleteId, { origin: 'settings' });
    } else if (app.jobs) {
      // HR settings (and the resting HR source) change zones and relative effort: recompute them (histogram based)
      const hrKeys = ['maxHr', 'restingHr', 'hrZoneMethod', 'hrZones', 'sex', 'birthDate'] as const;
      if (hrKeys.some(changed) || preferred(before, 'heart') !== preferred(next, 'heart')) {
        const today = new Date().toISOString().slice(0, 10);
        app.jobs.enqueueDerive(req.athleteId, { origin: 'settings', workoutIds: [], sinceDay: today });
      }
    }
    return next;
  });
}

/** Lets other modules invalidate the cached counts (e.g. after an import). */
export function invalidateStatusCounts(): void {
  countsCache.clear();
}
