import { all, prepare, tx } from '../db/db';
import type { DeriveStep } from '../features/types';

interface Row {
  id: number;
  start_ts: number;
  end_ts: number;
  sport: string;
  source_name: string | null;
  has_route: number;
  has_hr: number;
  distance_m: number | null;
  energy_kcal: number | null;
  duplicate_of: number | null;
}

/** How much data a workout carries; the richer copy of a duplicate pair wins. */
function score(r: Row): number {
  return (
    (r.has_route ? 8 : 0) +
    (r.has_hr ? 4 : 0) +
    (r.distance_m ? 2 : 0) +
    (r.energy_kcal ? 1 : 0) +
    (/watch/i.test(r.source_name ?? '') ? 0.5 : 0)
  );
}

const COLS = `id, start_ts, end_ts, sport, source_name, has_route, (hr_hist IS NOT NULL OR avg_hr IS NOT NULL) AS has_hr,
  distance_m, energy_kcal, duplicate_of`;

/**
 * Overlapping workouts of the same sport recorded by different sources (e.g. Strava wrote a copy of an
 * Apple Watch run back to Health) → `duplicate_of` is set on the copy with less data.
 */
export function detectDuplicates(
  db: import('../db/db').Db,
  athleteId: number,
  workoutIds: number[] | 'all',
): number {
  let rows: Row[];
  if (workoutIds === 'all') {
    rows = all<Row>(db, `SELECT ${COLS} FROM workouts WHERE athlete_id = ? ORDER BY start_ts`, [athleteId]);
  } else {
    if (!workoutIds.length) return 0;
    const byId = new Map<number, Row>();
    const win = prepare(db, 'SELECT start_ts, end_ts FROM workouts WHERE id = ? AND athlete_id = ?');
    const overlap = prepare(
      db,
      `SELECT ${COLS} FROM workouts WHERE athlete_id = ? AND start_ts < ? AND end_ts > ?`,
    );
    for (const id of workoutIds) {
      const w = win.get(id, athleteId) as { start_ts: number; end_ts: number } | undefined;
      if (!w) continue;
      for (const r of overlap.all(athleteId, w.end_ts, w.start_ts) as unknown as Row[]) byId.set(r.id, r);
    }
    rows = [...byId.values()].sort((a, b) => a.start_ts - b.start_ts);
  }
  // union-find over overlapping same-sport pairs from different sources
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let p = parent.get(x) ?? x;
    while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
    parent.set(x, p);
    return p;
  };
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i]!;
    for (let j = i + 1; j < rows.length && rows[j]!.start_ts < a.end_ts; j++) {
      const b = rows[j]!;
      if (a.sport !== b.sport || (a.source_name ?? '') === (b.source_name ?? '')) continue;
      const ov = Math.min(a.end_ts, b.end_ts) - Math.max(a.start_ts, b.start_ts);
      const shorter = Math.min(a.end_ts - a.start_ts, b.end_ts - b.start_ts);
      if (shorter > 0 && ov >= 0.5 * shorter) parent.set(find(b.id), find(a.id));
    }
  }
  const groups = new Map<number, Row[]>();
  for (const r of rows) {
    const g = find(r.id);
    let list = groups.get(g);
    if (!list) groups.set(g, (list = []));
    list.push(r);
  }
  const upd = prepare(db, 'UPDATE workouts SET duplicate_of = ? WHERE id = ?');
  let marked = 0;
  tx(db, () => {
    for (const list of groups.values()) {
      if (list.length === 1) {
        if (list[0]!.duplicate_of !== null) upd.run(null, list[0]!.id);
        continue;
      }
      const primary = [...list].sort((x, y) => score(y) - score(x) || x.id - y.id)[0]!;
      for (const r of list) {
        const want = r.id === primary.id ? null : primary.id;
        if (r.duplicate_of !== want) upd.run(want, r.id);
        if (want !== null) marked++;
      }
    }
  });
  return marked;
}

export const duplicatesStep: DeriveStep = {
  id: 'core.duplicates',
  label: 'Duplicate detection',
  weight: 0.3,
  run(ctx) {
    const n = detectDuplicates(ctx.db, ctx.athleteId, ctx.workoutIds);
    ctx.report(1, n ? `${n} duplicates` : undefined);
  },
};
