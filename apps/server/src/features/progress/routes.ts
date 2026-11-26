import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PROGRESS_POWER_COMPARES, PROGRESS_POWER_PERIODS, type ProgressPreferences } from '@cadence/shared';
import { setSetting } from '../../core/settings';
import { badRequest, notFound } from '../../lib/http';
import { addDays, parseDay, today as serverToday } from '../../lib/time';
import { firstActivityDay, resolveToday, zDay, zSport, zVolumeMetric } from './common';
import { fitness, physiology } from './fitness';
import { ftpEstimate, powerCurve } from './power';
import { athletesMissingPowerBests } from './power-curve';
import { effortHistory, predictions, records } from './records';
import { getPreferences, intensity, paceAtHr, PREFERENCES_KEY, trends } from './trends';
import { compare, overview, volume, weeklySnapshot, yearOverYear } from './volume';
import { athletesMissingMetrics } from './workout-metrics';

const MAX_RANGE_DAYS = 40 * 366;

const rangeQuery = z.object({
  sport: zSport,
  fromDay: zDay.optional(),
  toDay: zDay.optional(),
  today: zDay.optional(),
});

/** Resolve the day range (defaults: first activity … today) and validate it. */
function range(
  app: FastifyInstance,
  athleteId: number,
  q: { sport: string | null; fromDay?: string; toDay?: string; today?: string },
  fallbackDays = 365,
): { fromDay: string; toDay: string; today: string } {
  const today = resolveToday(q.today);
  const toDay = q.toDay ?? today;
  const fromDay = q.fromDay ?? firstActivityDay(app.db, athleteId, q.sport) ?? addDays(toDay, -fallbackDays);
  if (fromDay > toDay) throw badRequest('fromDay must not be after toDay');
  if (parseDay(toDay)! - parseDay(fromDay)! > MAX_RANGE_DAYS) throw badRequest('Range too long');
  return { fromDay, toDay, today };
}

const singleSport = (sport: string | null): string => {
  if (!sport) throw badRequest('sport is required');
  return sport;
};

const bpm = z.coerce.number().int().min(30).max(240);

/** Progress endpoints, mounted under /api/progress. */
export default async function progressRoutes(app: FastifyInstance) {
  // After an update that changed a cache version (or a database from before a cache existed), workouts have no
  // current rows: fill them in the background (the derive steps catch up every stale row) instead of in the first
  // request, which would compute them all on the server's main thread. One queued job is enough (busy).
  app.addHook('onReady', async () => {
    if (!app.jobs) return;
    for (const athleteId of new Set([...athletesMissingMetrics(app.db), ...athletesMissingPowerBests(app.db)])) {
      if (!app.jobs.busy(athleteId))
        app.jobs.enqueueDerive(athleteId, { origin: 'upgrade', workoutIds: [], sinceDay: serverToday() });
    }
  });

  app.get('/overview', async (req) => overview(app.db, req.athleteId));

  app.get('/volume', async (req) => {
    const q = rangeQuery.extend({ bucket: z.enum(['week', 'month', 'year']).default('week') }).parse(req.query);
    const r = range(app, req.athleteId, q);
    return volume(app.db, req.athleteId, { sport: q.sport, bucket: q.bucket, fromDay: r.fromDay, toDay: r.toDay });
  });

  app.get('/yoy', async (req) => {
    const q = z.object({ sport: zSport, metric: zVolumeMetric.default('distance'), today: zDay.optional() }).parse(req.query);
    return yearOverYear(app.db, req.athleteId, { sport: q.sport, metric: q.metric, today: resolveToday(q.today) });
  });

  app.get('/compare', async (req) => {
    const q = rangeQuery
      .extend({
        period: z.enum(['week', 'month', 'year', 'custom']).default('week'),
        offset: z.coerce.number().int().min(0).max(520).default(0),
      })
      .parse(req.query);
    const today = resolveToday(q.today);
    if (q.period === 'custom') {
      if (!q.fromDay || !q.toDay) throw badRequest('custom comparison needs fromDay and toDay');
      if (q.fromDay > q.toDay) throw badRequest('fromDay must not be after toDay');
      if (parseDay(q.toDay)! - parseDay(q.fromDay)! > MAX_RANGE_DAYS) throw badRequest('Range too long');
    }
    return compare(app.db, req.athleteId, { ...q, today });
  });

  app.get('/snapshot', async (req) => {
    const q = z.object({ today: zDay.optional() }).parse(req.query);
    return weeklySnapshot(app.db, req.athleteId, resolveToday(q.today));
  });

  app.get('/trends', async (req) => {
    const q = rangeQuery.parse(req.query);
    const sport = singleSport(q.sport);
    const r = range(app, req.athleteId, q);
    return trends(app.db, req.athleteId, { sport, fromDay: r.fromDay, toDay: r.toDay });
  });

  app.get('/pace-at-hr', async (req) => {
    const q = rangeQuery.extend({ lo: bpm.optional(), hi: bpm.optional() }).parse(req.query);
    const sport = singleSport(q.sport);
    if ((q.lo === undefined) !== (q.hi === undefined)) throw badRequest('lo and hi go together');
    if (q.lo !== undefined && q.hi! <= q.lo) throw badRequest('hi must be greater than lo');
    const r = range(app, req.athleteId, q);
    return paceAtHr(app.db, req.athleteId, { sport, fromDay: r.fromDay, toDay: r.toDay, lo: q.lo, hi: q.hi });
  });

  app.get('/intensity', async (req) => {
    const q = rangeQuery.extend({ bucket: z.enum(['week', 'month']).default('week') }).parse(req.query);
    const r = range(app, req.athleteId, q);
    return intensity(app.db, req.athleteId, { sport: q.sport, bucket: q.bucket, fromDay: r.fromDay, toDay: r.toDay });
  });

  app.get('/records', async (req) => {
    const q = z.object({ sport: zSport, today: zDay.optional() }).parse(req.query);
    return records(app.db, req.athleteId, { sport: q.sport, today: resolveToday(q.today) });
  });

  app.get('/records/history', async (req) => {
    const q = z.object({ sport: zSport, effort: z.string().min(1).max(20) }).parse(req.query);
    const h = effortHistory(app.db, req.athleteId, { sport: singleSport(q.sport), effort: q.effort });
    if (!h) throw notFound('Best effort');
    return h;
  });

  app.get('/predictions', async (req) => {
    const q = z.object({ today: zDay.optional() }).parse(req.query);
    return predictions(app.db, req.athleteId, resolveToday(q.today));
  });

  app.get('/fitness', async (req) => {
    const q = rangeQuery.parse(req.query);
    const today = resolveToday(q.today);
    const r = range(app, req.athleteId, { ...q, today }, 365);
    return fitness(app.db, req.athleteId, { sport: q.sport, fromDay: r.fromDay, toDay: r.toDay, today });
  });

  app.get('/physiology', async (req) => {
    const q = rangeQuery.parse(req.query);
    const r = range(app, req.athleteId, { ...q, sport: null });
    return physiology(app.db, req.athleteId, { fromDay: r.fromDay, toDay: r.toDay });
  });

  app.get('/power/curve', async (req) => {
    const q = z
      .object({
        sport: zSport,
        period: z.enum(PROGRESS_POWER_PERIODS).default('90d'),
        year: z.coerce.number().int().min(1970).max(2200).optional(),
        fromDay: zDay.optional(),
        toDay: zDay.optional(),
        compare: z.enum(PROGRESS_POWER_COMPARES).default('allTime'),
        today: zDay.optional(),
      })
      .parse(req.query);
    if (q.period === 'custom') {
      if (!q.fromDay || !q.toDay) throw badRequest('custom period needs fromDay and toDay');
      if (q.fromDay > q.toDay) throw badRequest('fromDay must not be after toDay');
      if (parseDay(q.toDay)! - parseDay(q.fromDay)! > MAX_RANGE_DAYS) throw badRequest('Range too long');
    }
    return powerCurve(app.db, req.athleteId, { ...q, today: resolveToday(q.today) });
  });

  app.get('/power/ftp', async (req) => {
    const q = z.object({ sport: zSport, today: zDay.optional() }).parse(req.query);
    return ftpEstimate(app.db, req.athleteId, { sport: q.sport, today: resolveToday(q.today) });
  });

  app.get('/preferences', async (req): Promise<ProgressPreferences> => getPreferences(app.db, req.athleteId));

  app.patch('/preferences', async (req): Promise<ProgressPreferences> => {
    const body = z
      .object({
        hrBands: z
          .record(
            z.string().max(40),
            z.object({ lo: bpm, hi: bpm }).refine((b) => b.hi > b.lo, 'hi must be greater than lo').nullable(),
          )
          .optional(),
      })
      .parse(req.body ?? {});
    const prefs = getPreferences(app.db, req.athleteId);
    for (const [sport, band] of Object.entries(body.hrBands ?? {})) {
      if (band) prefs.hrBands[sport] = band;
      else delete prefs.hrBands[sport];
    }
    setSetting(app.db, req.athleteId, PREFERENCES_KEY, prefs);
    return prefs;
  });
}
