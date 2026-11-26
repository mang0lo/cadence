import { preferDeviceWorkouts } from '../core/sources';
import { all, prepare, tx, type Db } from '../db/db';
import type { DeriveStep } from '../features/types';

/** What duplicate detection needs to know about a workout (columns of `workouts`, see COLS). */
export interface DupCandidate {
  id: number;
  start_ts: number;
  end_ts: number;
  sport: string;
  source_name: string | null;
  has_route: number;
  has_hr: number;
  distance_m: number | null;
  energy_kcal: number | null;
  /** 1 = the device's own FIT file. */
  from_device: number;
}

interface Row extends DupCandidate {
  duplicate_of: number | null;
}

/**
 * How much data a workout carries; the richer copy of a duplicate pair wins, unless Settings → My watch says which
 * source to prefer (the watch's own FIT copy, or Apple Health's).
 */
function score(r: DupCandidate, preferDevice: boolean): number {
  return (
    (!!r.from_device === preferDevice ? 100 : 0) +
    (r.has_route ? 8 : 0) +
    (r.has_hr ? 4 : 0) +
    (r.distance_m ? 2 : 0) +
    (r.energy_kcal ? 1 : 0) +
    (/watch/i.test(r.source_name ?? '') ? 0.5 : 0)
  );
}

/** Length of the union of [start, end) spans. */
function unionLength(spans: [number, number][]): number {
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let a = -Infinity;
  let b = -Infinity;
  for (const [s, e] of spans) {
    if (s > b) {
      if (b > a) total += b - a;
      a = s;
      b = e;
    } else if (e > b) b = e;
  }
  return b > a ? total + b - a : total;
}

/**
 * `duplicate_of` for every workout (null = it counts). Workouts are taken from the most to the least data (see
 * score); one is a copy when at least half of its own time is already covered by kept workouts of the same sport
 * from other sources, and then points to the kept workout it overlaps most. Decided per workout, never through
 * chains of overlaps: when one source split a session in two and another recorded it whole, both halves stay.
 */
export function resolveDuplicates(rows: DupCandidate[], preferDevice: boolean): Map<number, number | null> {
  const out = new Map<number, number | null>();
  const byStart = [...rows].sort((a, b) => a.start_ts - b.start_ts || a.id - b.id);
  for (let i = 0; i < byStart.length; ) {
    // a workout only competes with the workouts it overlaps: resolve each run of overlapping ones on its own
    let j = i + 1;
    let end = byStart[i]!.end_ts;
    while (j < byStart.length && byStart[j]!.start_ts < end) end = Math.max(end, byStart[j++]!.end_ts);
    const group = byStart
      .slice(i, j)
      .sort((x, y) => score(y, preferDevice) - score(x, preferDevice) || x.id - y.id);
    const kept: DupCandidate[] = [];
    for (const r of group) {
      let original: number | null = null;
      const dur = r.end_ts - r.start_ts;
      if (dur > 0) {
        const spans: [number, number][] = [];
        let most = 0;
        for (const k of kept) {
          if (k.sport !== r.sport || (k.source_name ?? '') === (r.source_name ?? '')) continue;
          const a = Math.max(k.start_ts, r.start_ts);
          const b = Math.min(k.end_ts, r.end_ts);
          if (b <= a) continue;
          spans.push([a, b]);
          if (b - a > most) {
            most = b - a;
            original = k.id;
          }
        }
        if (original !== null && unionLength(spans) < 0.5 * dur) original = null;
      }
      out.set(r.id, original);
      if (original === null) kept.push(r);
    }
    i = j;
  }
  return out;
}

const COLS = `id, start_ts, end_ts, sport, source_name, has_route, (hr_hist IS NOT NULL OR avg_hr IS NOT NULL) AS has_hr,
  distance_m, energy_kcal, duplicate_of, (ext_key LIKE 'fit:%') AS from_device`;

/**
 * The given workouts and every workout linked to them through a chain of overlaps: whether a workout counts can
 * depend on one it does not overlap itself (its original's own original), so an incremental run must see the whole
 * chain to decide exactly like a full one.
 */
function loadChains(db: Db, athleteId: number, ids: number[]): Row[] {
  const byId = new Map<number, Row>();
  const one = prepare(db, `SELECT ${COLS} FROM workouts WHERE id = ? AND athlete_id = ?`);
  const overlap = prepare(db, `SELECT ${COLS} FROM workouts WHERE athlete_id = ? AND start_ts < ? AND end_ts > ?`);
  for (const id of ids) {
    if (byId.has(id)) continue; // loaded with the chain of an earlier id
    const w = one.get(id, athleteId) as unknown as Row | undefined;
    if (!w) continue;
    byId.set(w.id, w);
    // widen the window until no workout overlapping it reaches beyond it
    let lo = w.start_ts;
    let hi = w.end_ts;
    for (;;) {
      let nlo = lo;
      let nhi = hi;
      for (const r of overlap.all(athleteId, hi, lo) as unknown as Row[]) {
        byId.set(r.id, r);
        if (r.start_ts < nlo) nlo = r.start_ts;
        if (r.end_ts > nhi) nhi = r.end_ts;
      }
      if (nlo === lo && nhi === hi) break;
      lo = nlo;
      hi = nhi;
    }
  }
  return [...byId.values()];
}

/**
 * Overlapping workouts of the same sport recorded by different sources (e.g. Strava wrote a copy of an
 * Apple Watch run back to Health) → `duplicate_of` is set on the copy with less data (see resolveDuplicates).
 */
export function detectDuplicates(db: Db, athleteId: number, workoutIds: number[] | 'all'): number {
  let rows: Row[];
  if (workoutIds === 'all') {
    rows = all<Row>(db, `SELECT ${COLS} FROM workouts WHERE athlete_id = ? ORDER BY start_ts`, [athleteId]);
  } else {
    if (!workoutIds.length) return 0;
    rows = loadChains(db, athleteId, workoutIds);
  }
  const want = resolveDuplicates(rows, preferDeviceWorkouts(db, athleteId));
  const upd = prepare(db, 'UPDATE workouts SET duplicate_of = ? WHERE id = ?');
  let marked = 0;
  tx(db, () => {
    for (const r of rows) {
      const original = want.get(r.id) ?? null;
      if (r.duplicate_of !== original) upd.run(original, r.id);
      if (original !== null) marked++;
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
