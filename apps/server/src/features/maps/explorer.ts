import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  MapsExplorerMonth,
  MapsExplorerResponse,
  MapsExplorerSummary,
  MapsExplorerTile,
} from '@cadence/shared';
import { all, get, type Db } from '../../db/db';
import { addDays, localDay, today } from '../../lib/time';
import { explorerStats, tileBounds, tileKey, type ExplorerStats } from './tiles';

const query = z.object({
  zoom: z.coerce
    .number()
    .int()
    .refine((v) => v === 14 || v === 17, { message: 'zoom must be 14 or 17' })
    .default(14),
  sport: z.string().max(500).optional(),
});

interface TileRow {
  x: number;
  y: number;
  visits: number;
  first_ts: number;
  first_tz: number;
  first_id: number;
}

interface ExplorerData {
  zoom: 14 | 17;
  rows: TileRow[];
  keys: Set<number>;
  stats: ExplorerStats;
  months: MapsExplorerMonth[];
  workouts: number;
}

const VISIBLE = 'w.hidden = 0 AND w.duplicate_of IS NULL';

function sportClause(sports: string[]): { sql: string; params: string[] } {
  return sports.length
    ? { sql: ` AND w.sport IN (${sports.map(() => '?').join(',')})`, params: sports }
    : { sql: '', params: [] };
}

/** Changes whenever the set of visible tiles can change (new / changed / hidden workouts). */
function dataVersion(db: Db, athleteId: number): string {
  // sums of ids (not just counts) so that swapping one workout for another or hiding A while unhiding B still differs
  const w = get<{ n: number; ids: number; u: number; h: number; d: number }>(
    db,
    `SELECT COUNT(*) AS n, COALESCE(SUM(id), 0) AS ids, COALESCE(MAX(updated_at), 0) AS u,
            COALESCE(SUM(hidden * id), 0) AS h, COALESCE(SUM((duplicate_of IS NOT NULL) * id), 0) AS d
     FROM workouts WHERE athlete_id = ? AND has_route = 1`,
    [athleteId],
  )!;
  const t = get<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM maps_workout_tiles WHERE athlete_id = ? AND z = 14',
    [athleteId],
  )!;
  return [w.n, w.ids, w.u, w.h, w.d, t.n].join(':');
}

const cache = new WeakMap<Db, Map<string, ExplorerData>>();
const CACHE_ENTRIES = 4;

/** First visit per tile, month series and the explorer statistics (cached until the workouts change). */
export function loadExplorer(db: Db, athleteId: number, zoom: 14 | 17, sports: string[]): ExplorerData {
  const key = `${athleteId}|${zoom}|${[...sports].sort().join(',')}|${dataVersion(db, athleteId)}`;
  let perDb = cache.get(db);
  if (!perDb) cache.set(db, (perDb = new Map()));
  const hit = perDb.get(key);
  if (hit) return hit;

  const sc = sportClause(sports);
  // MIN() makes SQLite take the bare columns (tz, workout id) from the row of the first visit.
  const rows = all<TileRow>(
    db,
    `SELECT t.x AS x, t.y AS y, COUNT(*) AS visits, MIN(w.start_ts) AS first_ts, w.tz_min AS first_tz, w.id AS first_id
     FROM maps_workout_tiles t JOIN workouts w ON w.id = t.workout_id
     WHERE t.athlete_id = ? AND t.z = ? AND ${VISIBLE}${sc.sql}
     GROUP BY t.x, t.y`,
    [athleteId, zoom, ...sc.params],
  );
  const keys = new Set<number>();
  for (const r of rows) keys.add(tileKey(r.x, r.y));
  const stats = explorerStats(keys);

  const perMonth = new Map<string, number>();
  for (const r of rows) {
    const m = localDay(r.first_ts, r.first_tz).slice(0, 7);
    perMonth.set(m, (perMonth.get(m) ?? 0) + 1);
  }
  const workouts = get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM workouts w
     WHERE w.athlete_id = ? AND w.has_route = 1 AND ${VISIBLE}${sc.sql}
       AND EXISTS (SELECT 1 FROM maps_workout_tiles t WHERE t.workout_id = w.id AND t.z = 14)`,
    [athleteId, ...sc.params],
  )!.n;

  const data: ExplorerData = {
    zoom,
    rows,
    keys,
    stats,
    months: monthSeries(perMonth),
    workouts,
  };
  perDb.set(key, data);
  while (perDb.size > CACHE_ENTRIES) perDb.delete(perDb.keys().next().value!);
  return data;
}

/** 'YYYY-MM' → next month. */
function nextMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

/** Every month from the first visit to the current month (gaps filled with 0) with running totals. */
export function monthSeries(perMonth: Map<string, number>, now = today().slice(0, 7)): MapsExplorerMonth[] {
  if (!perMonth.size) return [];
  const first = [...perMonth.keys()].sort()[0]!;
  const last = [...perMonth.keys(), now].sort().pop()!;
  const out: MapsExplorerMonth[] = [];
  let total = 0;
  for (let m = first; m <= last; m = nextMonth(m)) {
    const n = perMonth.get(m) ?? 0;
    total += n;
    out.push({ month: m, newTiles: n, total });
  }
  return out;
}

function parseSports(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function registerExplorerRoutes(app: FastifyInstance): void {
  app.get('/explorer', async (req): Promise<MapsExplorerResponse> => {
    const q = query.parse(req.query);
    const zoom = q.zoom as 14 | 17;
    const d = loadExplorer(app.db, req.athleteId, zoom, parseSports(q.sport));
    const clusterKeys = new Set(d.stats.maxCluster.keys);

    let tiles: MapsExplorerTile[] = [];
    let compact: MapsExplorerResponse['compact'] = null;
    if (zoom === 14) {
      tiles = d.rows.map((r) => {
        const k = tileKey(r.x, r.y);
        return {
          x: r.x,
          y: r.y,
          firstTs: r.first_ts,
          tzMin: r.first_tz,
          visits: r.visits,
          workoutId: r.first_id,
          interior: d.stats.interior.has(k),
          cluster: clusterKeys.has(k),
        };
      });
    } else {
      compact = { x: d.rows.map((r) => r.x), y: d.rows.map((r) => r.y) };
    }

    let bounds: MapsExplorerResponse['bounds'] = null;
    if (d.rows.length) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const r of d.rows) {
        if (r.x < x0) x0 = r.x;
        if (r.x > x1) x1 = r.x;
        if (r.y < y0) y0 = r.y;
        if (r.y > y1) y1 = r.y;
      }
      bounds = tileBounds(x0, y0, zoom, x1 - x0 + 1, y1 - y0 + 1);
    }

    const sports = all<{ sport: string; count: number }>(
      app.db,
      `SELECT sport, COUNT(*) AS count FROM workouts w
       WHERE athlete_id = ? AND has_route = 1 AND ${VISIBLE}
       GROUP BY sport ORDER BY count DESC, sport`,
      [req.athleteId],
    );

    return {
      zoom,
      totals: {
        tiles: d.stats.tiles,
        maxSquare: d.stats.maxSquare?.size ?? 0,
        maxCluster: d.stats.maxCluster.size,
        interior: d.stats.interior.size,
        workouts: d.workouts,
      },
      maxSquare: d.stats.maxSquare,
      months: d.months,
      tiles,
      compact,
      bounds,
      sports,
    };
  });

  app.get('/explorer/summary', async (req): Promise<MapsExplorerSummary> => {
    const d = loadExplorer(app.db, req.athleteId, 14, []);
    const nowMonth = today().slice(0, 7);
    const prevDay = addDays(`${nowMonth}-01`, -1);
    const prevMonth = prevDay.slice(0, 7);
    const monthNew = (m: string) => d.months.find((x) => x.month === m)?.newTiles ?? 0;
    return {
      tiles: d.stats.tiles,
      maxSquare: d.stats.maxSquare?.size ?? 0,
      maxCluster: d.stats.maxCluster.size,
      newThisMonth: monthNew(nowMonth),
      newLastMonth: monthNew(prevMonth),
      workouts: d.workouts,
    };
  });
}
