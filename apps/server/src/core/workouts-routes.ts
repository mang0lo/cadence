import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  SPORTS,
  sportFromActivityType,
  workoutTitle,
  type Page,
  type SportCount,
  type WorkoutDetail,
  type WorkoutStreams,
  type WorkoutSummary,
} from '@cadence/shared';
import { all, get, run } from '../db/db';
import { refreshDailyActivity } from '../derive/daily';
import { formatIsoUtc } from '../import/dates';
import { gunzipJson } from '../lib/gzip';
import { notFound } from '../lib/http';
import { localDay } from '../lib/time';
import { SUMMARY_COLS, getStreamsBlob, getWorkoutDetail, toSummary, type WorkoutRow } from './workouts';

const bool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const listQuery = z.object({
  sport: z.string().max(500).optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  q: z.string().max(200).optional(),
  hasRoute: bool.optional(),
  sort: z.enum(['start', 'distance', 'duration', 'effort', 'elevation']).default('start'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  includeHidden: bool.optional(),
  includeDuplicates: bool.optional(),
});

const patchBody = z
  .object({
    name: z.string().max(200),
    notes: z.string().max(20_000).nullable(),
    sport: z.string().refine((s) => s in SPORTS, { message: 'Unknown sport' }),
    hidden: z.boolean(),
  })
  .partial();

const idParam = z.object({ id: z.coerce.number().int().positive() });

const SORT_COLS: Record<string, string> = {
  start: 'start_ts',
  distance: 'distance_m',
  duration: 'duration_s',
  effort: 'effort',
  elevation: 'elevation_gain_m',
};

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const xmlEscape = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );

/** Sports whose English/German label (or key) matches a search term, so "Lauf" or "run" finds unnamed runs. */
function sportsMatching(q: string): string[] {
  const s = q.trim().toLowerCase();
  if (s.length < 2) return [];
  return Object.values(SPORTS)
    .filter(
      (i) =>
        i.key.includes(s) || i.label.en.toLowerCase().includes(s) || i.label.de.toLowerCase().includes(s),
    )
    .map((i) => i.key);
}

const GPX_TYPE: Record<string, string> = {
  run: 'running',
  ride: 'cycling',
  walk: 'walking',
  hike: 'hiking',
  swim: 'swimming',
};

/** Core workout endpoints, mounted under /api. */
export default async function workoutRoutes(app: FastifyInstance) {
  app.get('/workouts', async (req): Promise<Page<WorkoutSummary>> => {
    const q = listQuery.parse(req.query);
    const where = ['athlete_id = ?'];
    const params: unknown[] = [req.athleteId];
    if (!q.includeHidden) where.push('hidden = 0');
    if (!q.includeDuplicates) where.push('duplicate_of IS NULL');
    if (q.sport) {
      const sports = q.sport
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (sports.length) {
        where.push(`sport IN (${sports.map(() => '?').join(',')})`);
        params.push(...sports);
      }
    }
    if (q.from !== undefined) {
      where.push('start_ts >= ?');
      params.push(q.from);
    }
    if (q.to !== undefined) {
      where.push('start_ts < ?');
      params.push(q.to);
    }
    if (q.hasRoute !== undefined) {
      where.push('has_route = ?');
      params.push(q.hasRoute ? 1 : 0);
    }
    if (q.q?.trim()) {
      const like = `%${escapeLike(q.q.trim())}%`;
      const sports = sportsMatching(q.q);
      where.push(
        `(name LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR source_name LIKE ? ESCAPE '\\'${
          sports.length ? ` OR (name = '' AND sport IN (${sports.map(() => '?').join(',')}))` : ''
        })`,
      );
      params.push(like, like, like, ...sports);
    }
    const col = SORT_COLS[q.sort]!;
    const dir = q.order === 'asc' ? 'ASC' : 'DESC';
    const whereSql = where.join(' AND ');
    const total = get<{ n: number }>(
      app.db,
      `SELECT COUNT(*) AS n FROM workouts WHERE ${whereSql}`,
      params,
    )!.n;
    const rows = all<WorkoutRow>(
      app.db,
      `SELECT ${SUMMARY_COLS} FROM workouts WHERE ${whereSql}
       ORDER BY ${col} IS NULL, ${col} ${dir}, start_ts ${dir}, id ${dir} LIMIT ? OFFSET ?`,
      [...params, q.limit, q.offset],
    );
    return { items: rows.map(toSummary), total, limit: q.limit, offset: q.offset };
  });

  app.get('/workouts/:id', async (req): Promise<WorkoutDetail> => {
    const { id } = idParam.parse(req.params);
    const w = getWorkoutDetail(app.db, req.athleteId, id);
    if (!w) throw notFound('Workout');
    return w;
  });

  app.get('/workouts/:id/streams', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const blob = getStreamsBlob(app.db, req.athleteId, id);
    if (blob === undefined) throw notFound('Workout');
    if (blob === null) return { t: [] } satisfies WorkoutStreams;
    // stored as gzip(JSON): hand it out unchanged when the client accepts gzip
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      reply
        .header('content-encoding', 'gzip')
        .header('vary', 'accept-encoding')
        .type('application/json; charset=utf-8');
      return reply.send(Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength));
    }
    return gunzipJson<WorkoutStreams>(blob);
  });

  app.patch('/workouts/:id', async (req): Promise<WorkoutDetail> => {
    const { id } = idParam.parse(req.params);
    const body = patchBody.parse(req.body ?? {});
    const w = get<{
      id: number;
      activity_type: string;
      sport: string;
      hidden: number;
      start_ts: number;
      tz_min: number;
    }>(
      app.db,
      'SELECT id, activity_type, sport, hidden, start_ts, tz_min FROM workouts WHERE id = ? AND athlete_id = ?',
      [id, req.athleteId],
    );
    if (!w) throw notFound('Workout');
    const sets: string[] = [];
    const params: unknown[] = [];
    if (body.name !== undefined) {
      const name = body.name.trim();
      sets.push('name = ?', 'name_locked = ?');
      params.push(name, name ? 1 : 0);
    }
    if (body.notes !== undefined) {
      sets.push('notes = ?');
      params.push(body.notes?.trim() ? body.notes : null);
    }
    const sportChanged = body.sport !== undefined && body.sport !== w.sport;
    if (body.sport !== undefined) {
      sets.push('sport = ?', 'sport_locked = ?');
      params.push(body.sport, body.sport === sportFromActivityType(w.activity_type) ? 0 : 1);
    }
    const hiddenChanged = body.hidden !== undefined && (body.hidden ? 1 : 0) !== w.hidden;
    if (body.hidden !== undefined) {
      sets.push('hidden = ?');
      params.push(body.hidden ? 1 : 0);
    }
    if (sets.length) {
      run(app.db, `UPDATE workouts SET ${sets.join(', ')}, updated_at = unixepoch() WHERE id = ?`, [
        ...params,
        id,
      ]);
      if (sportChanged)
        run(app.db, 'UPDATE best_efforts SET sport = ? WHERE workout_id = ?', [body.sport, id]);
      refreshDailyActivity(app.db, req.athleteId, localDay(w.start_ts, w.tz_min));
      // sport changes alter moving thresholds / best efforts; both change what features aggregate. No health
      // record changed: only this workout and its day are derived again (not the daily metrics of every type).
      if (sportChanged || hiddenChanged)
        app.jobs.enqueueDerive(req.athleteId, {
          origin: 'workout',
          workoutIds: [id],
          sinceDay: localDay(w.start_ts, w.tz_min),
          records: false,
        });
    }
    return getWorkoutDetail(app.db, req.athleteId, id)!;
  });

  app.get<{ Querystring: { lang?: string } }>('/workouts/:id/gpx', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const w = get<{ name: string; sport: string; start_ts: number; tz_min: number; has_route: number }>(
      app.db,
      'SELECT name, sport, start_ts, tz_min, has_route FROM workouts WHERE id = ? AND athlete_id = ?',
      [id, req.athleteId],
    );
    if (!w) throw notFound('Workout');
    const blob = getStreamsBlob(app.db, req.athleteId, id);
    const s = blob ? gunzipJson<WorkoutStreams>(blob) : null;
    if (!s?.lat || !s.lon) throw notFound('Route');
    const lang = req.query.lang === 'de' ? 'de' : 'en';
    const title = workoutTitle({ name: w.name, sport: w.sport, startTs: w.start_ts, tzMin: w.tz_min }, lang);
    const halfCadence = w.sport === 'run' || w.sport === 'walk' || w.sport === 'hike';
    const out: string[] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Cadence" xmlns="http://www.topografix.com/GPX/1/1"',
      ' xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"',
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
      ' xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd http://www.garmin.com/xmlschemas/TrackPointExtension/v1 http://www.garmin.com/xmlschemas/TrackPointExtensionv1.xsd">',
      ` <metadata><name>${xmlEscape(title)}</name><time>${formatIsoUtc(w.start_ts)}</time></metadata>`,
      ` <trk><name>${xmlEscape(title)}</name><type>${GPX_TYPE[w.sport] ?? w.sport}</type><trkseg>`,
    ];
    // every part of the track (see WorkoutStreams.breaks) is its own <trkseg>
    const breaks = new Set(s.breaks ?? []);
    for (let i = 0; i < s.t.length; i++) {
      const lat = s.lat[i];
      const lon = s.lon[i];
      if (lat === undefined || lon === undefined) continue;
      if (breaks.has(i)) out.push(' </trkseg><trkseg>');
      const ele = s.ele?.[i];
      const hr = s.hr?.[i];
      const cadRaw = s.cadence?.[i];
      const cad =
        cadRaw === null || cadRaw === undefined ? null : Math.round(halfCadence ? cadRaw / 2 : cadRaw);
      let ext = '';
      if ((hr !== null && hr !== undefined) || cad !== null) {
        ext =
          '<extensions><gpxtpx:TrackPointExtension>' +
          (hr !== null && hr !== undefined ? `<gpxtpx:hr>${Math.round(hr)}</gpxtpx:hr>` : '') +
          (cad !== null ? `<gpxtpx:cad>${cad}</gpxtpx:cad>` : '') +
          '</gpxtpx:TrackPointExtension></extensions>';
      }
      out.push(
        `  <trkpt lat="${lat}" lon="${lon}">${ele !== null && ele !== undefined ? `<ele>${ele}</ele>` : ''}<time>${formatIsoUtc(
          w.start_ts + s.t[i]!,
        )}</time>${ext}</trkpt>`,
      );
    }
    out.push(' </trkseg></trk>', '</gpx>', '');
    // keep letters of every language (umlauts …); drop what file systems do not allow
    const file = `${title.replace(/[^\p{L}\p{N}\- ]+/gu, '').trim() || 'workout'}-${localDay(w.start_ts, w.tz_min)}.gpx`;
    reply
      .type('application/gpx+xml; charset=utf-8')
      .header(
        'content-disposition',
        // header values must be Latin-1: ASCII fallback plus the real name (RFC 5987)
        `attachment; filename="${file.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file)}`,
      );
    return out.join('\n');
  });

  app.get('/meta/sports', async (req): Promise<SportCount[]> =>
    all<SportCount>(
      app.db,
      `SELECT sport, COUNT(*) AS count, COALESCE(SUM(distance_m), 0) AS distanceM, COALESCE(SUM(duration_s), 0) AS durationS
       FROM workouts WHERE athlete_id = ? AND hidden = 0 AND duplicate_of IS NULL
       GROUP BY sport ORDER BY count DESC, sport`,
      [req.athleteId],
    ),
  );
}
