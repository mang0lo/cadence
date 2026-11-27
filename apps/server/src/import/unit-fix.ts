import { normalizeUnit } from '@cadence/shared';
import { all, get, prepare, run, type Db } from '../db/db';
import { fnv1a } from '../lib/hash';
import { ChangeScope, notePending } from './scope';

/** Volume units that versions up to 1.0 kept as exported (imperial / US pints, decilitres); litres since. */
const LATE_UNITS = ['dL', 'pt_us', 'fl_oz_imp', 'cup_imp', 'pt_imp'];

interface RecordRow {
  athlete_id: number;
  start_ts: number;
  hash: number;
  end_ts: number;
  tz_min: number;
  value: number;
  text: string | null;
  source_id: number;
  device_id: number | null;
  created_ts: number | null;
  meta: string | null;
}

/**
 * Migration: record types stored in one of LATE_UNITS (e.g. water in imperial fl oz, shown 35× too high) get their
 * records converted to litres — the value and the hash that dedupes re-imports (writer.ts), dropping rows that turn
 * out to be copies of one already stored in litres — and the next derive rebuilds their daily metrics.
 * A type whose history mixes units (an import warned "mixed units") cannot be split row by row: only its unit is
 * set, so later imports store litres again.
 */
export function convertLateVolumeUnits(db: Db): void {
  const types = all<{ id: number; identifier: string; unit: string }>(
    db,
    `SELECT id, identifier, unit FROM record_types WHERE unit IN (${LATE_UNITS.map(() => '?').join(',')})`,
    LATE_UNITS,
  );
  if (!types.length) return;
  const sources = new Map(
    all<{ id: number; name: string }>(db, 'SELECT id, name FROM sources').map((r) => [r.id, r.name]),
  );
  const del = prepare(db, 'DELETE FROM records WHERE athlete_id = ? AND type_id = ? AND start_ts = ? AND hash = ?');
  const ins = prepare(
    db,
    `INSERT OR IGNORE INTO records (athlete_id, type_id, start_ts, hash, end_ts, tz_min, value, text, source_id,
       device_id, created_ts, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const t of types) {
    const mixed = get(db, 'SELECT 1 FROM import_jobs WHERE stats LIKE ? LIMIT 1', [
      `%${t.identifier}: mixed units%`,
    ]);
    if (!mixed) {
      const f = normalizeUnit(1, t.unit).value;
      const since = new Map<number, number>();
      for (const r of all<RecordRow>(
        db,
        `SELECT athlete_id, start_ts, hash, end_ts, tz_min, value, text, source_id, device_id, created_ts, meta
         FROM records WHERE type_id = ? AND value IS NOT NULL`,
        [t.id],
      )) {
        const value = r.value * f;
        const hash = fnv1a(`${r.end_ts}|${sources.get(r.source_id) ?? ''}|${value.toPrecision(5)}|${r.text ?? ''}`);
        del.run(r.athlete_id, t.id, r.start_ts, r.hash);
        ins.run(
          r.athlete_id,
          t.id,
          r.start_ts,
          hash,
          r.end_ts,
          r.tz_min,
          value,
          r.text,
          r.source_id,
          r.device_id,
          r.created_ts,
          r.meta,
        );
        if (r.start_ts < (since.get(r.athlete_id) ?? Infinity)) since.set(r.athlete_id, r.start_ts);
      }
      for (const [athleteId, ts] of since) {
        const scope = new ChangeScope();
        scope.noteRecord(t.id, ts);
        notePending(db, athleteId, scope);
      }
    }
    run(db, "UPDATE record_types SET unit = 'L' WHERE id = ?", [t.id]);
  }
}
