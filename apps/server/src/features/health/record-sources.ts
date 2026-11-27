import { all, get, run, tx, type Db } from '../../db/db';
import type { DeriveStep } from '../types';

/**
 * Which sources and devices wrote the samples of a record type (the "sources" of a metric page), kept per type in
 * health_record_sources so a request for the whole history does not group millions of heart-rate samples on the HTTP
 * thread. The derive step recounts a type when its record_type_stats stamp (sample count and newest sample) changed;
 * the route serves the stored rows only while that stamp still matches (a COROS sync refreshes the stats without a
 * derive) and counts live otherwise.
 */

/** Stamp of a type's samples: count and newest sample, as record_type_stats holds them. */
export const sourcesStamp = (count: number | null | undefined, lastTs: number | null | undefined): string =>
  `${count ?? 0}|${lastTs ?? 0}`;

/** One group of samples: source × device (the names are joined by the reader). */
export interface SourceGroupRow {
  source_id: number;
  name: string | null;
  device: string | null;
  n: number;
  first_ts: number;
  last_ts: number;
}

/** Names of a source group's source and device ('Apple Watch (Watch7,3)'), joined onto rows with source_id / device_id. */
export const SOURCE_NAMES = `s.name, COALESCE(d.name, '') || CASE WHEN d.hardware IS NULL THEN '' ELSE ' (' || d.hardware || ')' END AS device`;

/** Recount the types whose samples changed since the last run; returns the number of types recounted. */
export function refreshRecordSources(db: Db, athleteId: number, check?: () => void): number {
  const stored = new Map(
    all<{ type_id: number; stamp: string }>(db, 'SELECT type_id, stamp FROM health_record_sources_stamp WHERE athlete_id = ?', [
      athleteId,
    ]).map((r) => [r.type_id, r.stamp]),
  );
  const types = all<{ type_id: number; count: number; last_ts: number | null }>(
    db,
    'SELECT type_id, count, last_ts FROM record_type_stats WHERE athlete_id = ?',
    [athleteId],
  );
  let n = 0;
  for (const t of types) {
    const stamp = sourcesStamp(t.count, t.last_ts);
    if (stored.get(t.type_id) === stamp) continue;
    check?.();
    const groups = all<{ source_id: number; device_id: number | null; n: number; first_ts: number; last_ts: number }>(
      db,
      `SELECT source_id, device_id, COUNT(*) AS n, MIN(start_ts) AS first_ts, MAX(start_ts) AS last_ts
       FROM records WHERE athlete_id = ? AND type_id = ? GROUP BY source_id, device_id`,
      [athleteId, t.type_id],
    );
    tx(db, () => {
      run(db, 'DELETE FROM health_record_sources WHERE athlete_id = ? AND type_id = ?', [athleteId, t.type_id]);
      for (const g of groups)
        run(
          db,
          `INSERT INTO health_record_sources (athlete_id, type_id, source_id, device_id, n, first_ts, last_ts)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [athleteId, t.type_id, g.source_id, g.device_id, g.n, g.first_ts, g.last_ts],
        );
      run(db, 'INSERT OR REPLACE INTO health_record_sources_stamp (athlete_id, type_id, stamp) VALUES (?, ?, ?)', [
        athleteId,
        t.type_id,
        stamp,
      ]);
    });
    n++;
  }
  // types without samples any more (data of a source removed)
  const gone = `athlete_id = ? AND type_id NOT IN (SELECT type_id FROM record_type_stats WHERE athlete_id = ?)`;
  run(db, `DELETE FROM health_record_sources WHERE ${gone}`, [athleteId, athleteId]);
  run(db, `DELETE FROM health_record_sources_stamp WHERE ${gone}`, [athleteId, athleteId]);
  return n;
}

/** The stored source groups of a type's whole history, or null when they are missing or older than `stamp`. */
export function storedSourceGroups(db: Db, athleteId: number, typeId: number, stamp: string): SourceGroupRow[] | null {
  const s = get<{ stamp: string }>(db, 'SELECT stamp FROM health_record_sources_stamp WHERE athlete_id = ? AND type_id = ?', [
    athleteId,
    typeId,
  ]);
  if (s?.stamp !== stamp) return null;
  return all<SourceGroupRow>(
    db,
    `SELECT g.source_id, ${SOURCE_NAMES}, g.n, g.first_ts, g.last_ts
     FROM health_record_sources g LEFT JOIN sources s ON s.id = g.source_id LEFT JOIN devices d ON d.id = g.device_id
     WHERE g.athlete_id = ? AND g.type_id = ?`,
    [athleteId, typeId],
  );
}

export const recordSourcesStep: DeriveStep = {
  id: 'health.record-sources',
  label: 'Sources of health records',
  weight: 1,
  run(ctx) {
    ctx.report(0.1);
    const n = refreshRecordSources(ctx.db, ctx.athleteId, ctx.checkCancelled);
    ctx.log(`health.record-sources: ${n} record types recounted`);
    ctx.report(1);
  },
};
