import { all, get, prepare, tx, type Db } from '../db/db';
import { getEffectiveHr, getSetting, getSettings, setSetting } from '../core/settings';
import type { DeriveStep } from '../features/types';
import { gunzipFloat32 } from '../lib/gzip';
import { effortPerMinute, trimpFromAverage, trimpFromHistogram, zonesFromHistogram } from './metrics';

/** HR parameters the stored zones / efforts were computed with. */
export interface EffortBasis {
  maxHr: number;
  restingHr: number;
  zoneBounds: number[];
  sex: string | null;
}

const BASIS_KEY = 'core.effortBasis';

export function currentEffortBasis(db: Db, athleteId: number): EffortBasis {
  const hr = getEffectiveHr(db, athleteId);
  const settings = getSettings(db, athleteId);
  const sex =
    settings.sex ??
    get<{ sex: string | null }>(db, 'SELECT sex FROM athletes WHERE id = ?', [athleteId])?.sex ??
    null;
  return { maxHr: hr.maxHr, restingHr: hr.restingHr, zoneBounds: hr.zoneBounds, sex };
}

function significantChange(a: EffortBasis | null, b: EffortBasis): boolean {
  if (!a) return true;
  return (
    a.maxHr !== b.maxHr ||
    Math.abs(a.restingHr - b.restingHr) >= 2 ||
    a.sex !== b.sex ||
    JSON.stringify(a.zoneBounds) !== JSON.stringify(b.zoneBounds)
  );
}

interface Row {
  id: number;
  sport: string;
  duration_s: number;
  moving_s: number | null;
  avg_hr: number | null;
  hr_hist: Uint8Array | null;
}

/**
 * HR zones (seconds in Z1..Z5) and relative effort for workouts:
 *   1. Banister TRIMP from the workout's HR histogram (time at each bpm),
 *   2. else TRIMP from average HR × duration,
 *   3. else a per-sport per-minute estimate (effort_estimated = 1).
 * The effective HR (max/resting/zones) is computed once per run. When it changed significantly since the
 * last run, every workout is recomputed and the context widens to workoutIds = 'all' for feature steps.
 */
export function computeEfforts(
  db: Db,
  athleteId: number,
  workoutIds: number[] | 'all',
): { all: boolean; count: number } {
  const current = currentEffortBasis(db, athleteId);
  const prev = getSetting<EffortBasis | null>(db, athleteId, BASIS_KEY, null);
  const changed = significantChange(prev, current);
  const basis = changed || !prev ? current : prev;
  const everything = workoutIds === 'all' || changed;
  const cols = 'id, sport, duration_s, moving_s, avg_hr, hr_hist';
  const rows: Row[] = everything
    ? all<Row>(db, `SELECT ${cols} FROM workouts WHERE athlete_id = ?`, [athleteId])
    : workoutIds.flatMap(
        (id) =>
          get<Row>(db, `SELECT ${cols} FROM workouts WHERE id = ? AND athlete_id = ?`, [id, athleteId]) ?? [],
      );
  const upd = prepare(
    db,
    'UPDATE workouts SET trimp = ?, effort = ?, effort_estimated = ?, hr_zones = ? WHERE id = ?',
  );
  tx(db, () => {
    for (const r of rows) {
      let trimp: number | null = null;
      let zones: number[] | null = null;
      let effort: number;
      let estimated = 0;
      let hist: Float32Array | null = null;
      if (r.hr_hist) {
        try {
          hist = gunzipFloat32(r.hr_hist);
        } catch {
          hist = null;
        }
      }
      const minutes = (r.moving_s ?? r.duration_s) / 60;
      if (hist && hist.some((x) => x > 0)) {
        trimp = trimpFromHistogram(hist, basis.restingHr, basis.maxHr, basis.sex);
        zones = zonesFromHistogram(hist, basis.zoneBounds);
        effort = trimp;
      } else if (r.avg_hr && r.avg_hr > 30) {
        trimp = trimpFromAverage(r.avg_hr, minutes * 60, basis.restingHr, basis.maxHr, basis.sex);
        effort = trimp;
      } else {
        effort = minutes * effortPerMinute(r.sport);
        estimated = 1;
      }
      upd.run(
        trimp === null ? null : Math.round(trimp * 10) / 10,
        Math.round(effort * 10) / 10,
        estimated,
        zones ? JSON.stringify(zones) : null,
        r.id,
      );
    }
    if (changed) setSetting(db, athleteId, BASIS_KEY, current);
  });
  return { all: everything, count: rows.length };
}

export const effortStep: DeriveStep = {
  id: 'core.effort',
  label: 'Heart rate zones & relative effort',
  weight: 0.5,
  run(ctx) {
    const r = computeEfforts(ctx.db, ctx.athleteId, ctx.workoutIds);
    // HR basis changed → every workout's effort changed: let feature steps see the full scope.
    if (r.all && ctx.workoutIds !== 'all') ctx.workoutIds = 'all';
    ctx.report(1, `${r.count} workouts`);
  },
};
