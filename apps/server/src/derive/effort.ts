import { all, get, prepare, tx, type Db } from '../db/db';
import { getEffectiveHr, getSetting, getSettings, setSetting } from '../core/settings';
import type { DeriveStep } from '../features/types';
import { gunzipFloat32 } from '../lib/gzip';
import { asCore } from './context';
import { effortPerMinute, trimpFromAverage, trimpFromHistogram, zonesFromHistogram } from './metrics';

/** HR parameters the stored zones / efforts were computed with. */
export interface EffortBasis {
  maxHr: number;
  restingHr: number;
  zoneBounds: number[];
  sex: string | null;
  /** EFFORT_VERSION the efforts were computed with (missing = 1). */
  version?: number;
}

const BASIS_KEY = 'core.effortBasis';
/**
 * Bump when the effort computation changes: the next derive recomputes every workout's effort once (cheap).
 * 2: TRIMP of a histogram that covers only part of the moving time is extrapolated to all of it.
 */
const EFFORT_VERSION = 2;

export function currentEffortBasis(db: Db, athleteId: number): EffortBasis {
  const hr = getEffectiveHr(db, athleteId);
  const settings = getSettings(db, athleteId);
  const sex =
    settings.sex ??
    get<{ sex: string | null }>(db, 'SELECT sex FROM athletes WHERE id = ?', [athleteId])?.sex ??
    null;
  return { maxHr: hr.maxHr, restingHr: hr.restingHr, zoneBounds: hr.zoneBounds, sex, version: EFFORT_VERSION };
}

function significantChange(a: EffortBasis | null, b: EffortBasis): boolean {
  if (!a) return true;
  return (
    a.maxHr !== b.maxHr ||
    Math.abs(a.restingHr - b.restingHr) >= 2 ||
    a.sex !== b.sex ||
    JSON.stringify(a.zoneBounds) !== JSON.stringify(b.zoneBounds) ||
    (a.version ?? 1) !== (b.version ?? 1)
  );
}

/** Below this share of the moving time covered by the HR histogram, its TRIMP is extrapolated to the rest. */
const FULL_COVERAGE = 0.95;

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
 *   1. Banister TRIMP from the workout's HR histogram (time at each bpm); a histogram with gaps (strap dropouts)
 *      is extrapolated to the moving time, so a gap never makes the effort lower than no HR stream at all would,
 *   2. else TRIMP from average HR × duration,
 *   3. else a per-sport per-minute estimate (effort_estimated = 1).
 * The effective HR (max/resting/zones) is computed once per run. When it changed significantly since the
 * last run, every workout is recomputed (`basisChanged`).
 */
export function computeEfforts(
  db: Db,
  athleteId: number,
  workoutIds: number[] | 'all',
): { all: boolean; basisChanged: boolean; count: number } {
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
      const covered = hist ? hist.reduce((s, x) => s + x, 0) : 0;
      if (hist && covered > 0) {
        trimp = trimpFromHistogram(hist, basis.restingHr, basis.maxHr, basis.sex);
        // time in zones stays as measured; the load of the minutes without HR is assumed to be like the rest
        if (covered < FULL_COVERAGE * minutes * 60) trimp *= Math.min(2, (minutes * 60) / covered);
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
  return { all: everything, basisChanged: changed, count: rows.length };
}

export const effortStep: DeriveStep = {
  id: 'core.effort',
  label: 'Heart rate zones & relative effort',
  weight: 0.5,
  run(ctx) {
    const r = computeEfforts(ctx.db, ctx.athleteId, ctx.workoutIds);
    // HR basis changed → every workout's effort changed. Steps that build on effort, TRIMP or zones see it in
    // ctx.changes; workoutIds stays "workouts whose inputs changed" (widening it rebuilt every feature cache).
    if (r.basisChanged) asCore(ctx).changes.effortBasis = true;
    ctx.report(1, `${r.count} workouts`);
  },
};
