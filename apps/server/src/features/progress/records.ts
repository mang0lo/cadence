import {
  BEST_EFFORTS,
  type ProgressEffortHistory,
  type ProgressEffortRef,
  type ProgressEffortRow,
  type ProgressHighlight,
  type ProgressHighlightKey,
  type ProgressPredictions,
  type ProgressRecordsResponse,
  type RacePrediction,
} from '@cadence/shared';
import { all, get, type Db } from '../../db/db';
import { heartMetric } from '../../core/sources';
import { SUMMARY_COLS, toSummary, type WorkoutRow } from '../../core/workouts';
import { addDays, localDay } from '../../lib/time';
import { median, RIEGEL_EXPONENT, riegel, shiftYears, timeFromVdot } from './math';

interface EffortRow {
  effort: string;
  elapsed_s: number;
  workout_id: number;
  name: string;
  sport: string;
  start_ts: number;
  tz_min: number;
  avg_hr: number | null;
}

function effortRows(db: Db, athleteId: number, sport: string, effort?: string): EffortRow[] {
  return all<EffortRow>(
    db,
    `SELECT be.effort, be.elapsed_s, be.workout_id, w.name, w.sport, w.start_ts, w.tz_min, w.avg_hr
     FROM best_efforts be JOIN workouts w ON w.id = be.workout_id
     WHERE be.athlete_id = ? AND be.sport = ? ${effort ? 'AND be.effort = ?' : ''}
       AND w.hidden = 0 AND w.duplicate_of IS NULL
     ORDER BY w.start_ts, w.id`,
    effort ? [athleteId, sport, effort] : [athleteId, sport],
  );
}

const toRef = (r: EffortRow): ProgressEffortRef => ({
  workoutId: r.workout_id,
  name: r.name,
  sport: r.sport,
  startTs: r.start_ts,
  tzMin: r.tz_min,
  elapsedS: r.elapsed_s,
});

/** Fastest of a list (ties: the earlier attempt keeps the record). */
function fastest(rows: EffortRow[]): EffortRow | null {
  let best: EffortRow | null = null;
  for (const r of rows) if (!best || r.elapsed_s < best.elapsed_s) best = r;
  return best;
}

/** Minimum distance for the "fastest average speed" record, so a 300 m jog does not win. */
const FASTEST_MIN_M: Record<string, number> = { run: 3000, walk: 2000, hike: 3000, ride: 10000, swim: 400, row: 1000 };

const HIGHLIGHTS: { key: ProgressHighlightKey; col: string; where?: (sport: string) => string; params?: (sport: string) => unknown[] }[] = [
  { key: 'longest', col: 'distance_m' },
  { key: 'longestTime', col: 'COALESCE(moving_s, duration_s)' },
  { key: 'climb', col: 'elevation_gain_m' },
  { key: 'fastest', col: 'avg_speed', where: () => 'AND distance_m >= ?', params: (s) => [FASTEST_MIN_M[s] ?? 1000] },
  { key: 'hardest', col: 'effort' },
];

export function records(db: Db, athleteId: number, q: { sport: string | null; today: string }): ProgressRecordsResponse {
  const sports = all<{ sport: string; workouts: number; efforts: number }>(
    db,
    `SELECT w.sport, COUNT(*) AS workouts,
       SUM(EXISTS (SELECT 1 FROM best_efforts be WHERE be.workout_id = w.id)) AS efforts
     FROM workouts w WHERE w.athlete_id = ? AND w.hidden = 0 AND w.duplicate_of IS NULL
     GROUP BY w.sport ORDER BY workouts DESC, w.sport`,
    [athleteId],
  );
  const sport = q.sport ?? sports.find((s) => s.efforts > 0)?.sport ?? sports[0]?.sport ?? null;
  if (!sport) return { sport: null, sports: [], efforts: [], highlights: [] };

  const yearStart = `${q.today.slice(0, 4)}-01-01`;
  const last12From = addDays(shiftYears(q.today, -1), 1);
  const rows = effortRows(db, athleteId, sport);
  const byEffort = new Map<string, EffortRow[]>();
  for (const r of rows) {
    let list = byEffort.get(r.effort);
    if (!list) byEffort.set(r.effort, (list = []));
    list.push(r);
  }
  const efforts: ProgressEffortRow[] = (BEST_EFFORTS[sport] ?? []).map((def) => {
    const list = (byEffort.get(def.key) ?? []).filter((r) => localDay(r.start_ts, r.tz_min) <= q.today);
    const inRange = (from: string) => list.filter((r) => localDay(r.start_ts, r.tz_min) >= from);
    const best = fastest(list);
    const year = fastest(inRange(yearStart));
    const last12 = fastest(inRange(last12From));
    return {
      effort: def.key,
      distanceM: def.distanceM,
      attempts: list.length,
      allTime: best && toRef(best),
      thisYear: year && toRef(year),
      last12m: last12 && toRef(last12),
    };
  });

  const highlights: ProgressHighlight[] = [];
  for (const h of HIGHLIGHTS) {
    const row = get<WorkoutRow & { v: number | null }>(
      db,
      `SELECT ${SUMMARY_COLS}, ${h.col} AS v FROM workouts
       WHERE athlete_id = ? AND sport = ? AND hidden = 0 AND duplicate_of IS NULL AND ${h.col} > 0 ${h.where?.(sport) ?? ''}
       ORDER BY ${h.col} DESC, start_ts LIMIT 1`,
      [athleteId, sport, ...(h.params?.(sport) ?? [])],
    );
    if (row && row.v !== null) highlights.push({ key: h.key, value: row.v, workout: toSummary(row) });
  }
  return { sport, sports: sports.map((s) => ({ sport: s.sport, workouts: s.workouts })), efforts, highlights };
}

export function effortHistory(db: Db, athleteId: number, q: { sport: string; effort: string }): ProgressEffortHistory | null {
  const def = (BEST_EFFORTS[q.sport] ?? []).find((d) => d.key === q.effort);
  if (!def) return null;
  const rows = effortRows(db, athleteId, q.sport, q.effort);
  let best = Infinity;
  const attempts = rows.map((r) => {
    const pr = r.elapsed_s < best;
    if (pr) best = r.elapsed_s;
    return { ...toRef(r), avgHr: r.avg_hr, pr };
  });
  const top = [...rows]
    .sort((a, b) => a.elapsed_s - b.elapsed_s || a.start_ts - b.start_ts)
    .slice(0, 10)
    .map((r, i) => ({ ...toRef(r), avgHr: r.avg_hr, rank: i + 1 }));
  return { sport: q.sport, effort: q.effort, distanceM: def.distanceM, attempts, top };
}

// ---------------------------------------------------------------------------
// Race predictor
// ---------------------------------------------------------------------------

export const PREDICTION_TARGETS = ['5k', '10k', 'half', 'marathon'] as const;
/** Shorter efforts predict long races poorly. */
const MIN_BASIS_M = 1500;
const WINDOWS = [90, 180, 365, 3650];

export interface Candidate {
  effort: string;
  distanceM: number;
  row: ProgressEffortRef;
}

/** Riegel prediction from the candidate closest in distance (log scale; ties → the longer effort). */
export function riegelFromCandidates(
  candidates: Candidate[],
  targetM: number,
): { elapsedS: number; basis: Candidate } | null {
  let best: Candidate | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const score = Math.abs(Math.log(targetM / c.distanceM));
    if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && best && c.distanceM > best.distanceM)) {
      best = c;
      bestScore = score;
    }
  }
  if (!best) return null;
  return { elapsedS: riegel(best.row.elapsedS, best.distanceM, targetM), basis: best };
}

/**
 * Recent VO2max of the preferred source (Settings → My watch, see heartMetric): median of the plausible readings in
 * the 30 days up to the latest plausible one.
 */
export function recentVo2max(db: Db, athleteId: number, today: string): { value: number; day: string } | null {
  const metric = heartMetric(db, athleteId, 'vo2max');
  const latest = get<{ day: string }>(
    db,
    `SELECT day FROM daily_metrics WHERE athlete_id = ? AND metric = ? AND day <= ? AND value BETWEEN 10 AND 95
     ORDER BY day DESC LIMIT 1`,
    [athleteId, metric, today],
  );
  if (!latest) return null;
  const values = all<{ value: number }>(
    db,
    `SELECT value FROM daily_metrics WHERE athlete_id = ? AND metric = ?
       AND day > ? AND day <= ? AND value BETWEEN 10 AND 95`,
    [athleteId, metric, addDays(latest.day, -30), latest.day],
  ).map((r) => r.value);
  const m = median(values);
  return m === null ? null : { value: Math.round(m * 10) / 10, day: latest.day };
}

export function predictions(db: Db, athleteId: number, today: string): ProgressPredictions {
  const defs = BEST_EFFORTS.run!;
  const rows = effortRows(db, athleteId, 'run').filter((r) => localDay(r.start_ts, r.tz_min) <= today);
  let windowDays = WINDOWS[0]!;
  let candidates: Candidate[] = [];
  for (const w of WINDOWS) {
    windowDays = w;
    const from = addDays(today, -w);
    const recent = rows.filter((r) => localDay(r.start_ts, r.tz_min) > from);
    candidates = defs
      .filter((d) => d.distanceM >= MIN_BASIS_M)
      .flatMap((d) => {
        const best = fastest(recent.filter((r) => r.effort === d.key));
        return best ? [{ effort: d.key, distanceM: d.distanceM, row: toRef(best) }] : [];
      });
    if (candidates.length) break;
  }
  const vo2 = recentVo2max(db, athleteId, today);
  const targets: RacePrediction[] = PREDICTION_TARGETS.map((key) => {
    const distanceM = defs.find((d) => d.key === key)!.distanceM;
    const r = riegelFromCandidates(candidates, distanceM);
    const v = vo2 ? timeFromVdot(vo2.value, distanceM) : null;
    return {
      key,
      distanceM,
      riegel: r && {
        elapsedS: Math.round(r.elapsedS),
        basis: { ...r.basis.row, effort: r.basis.effort, distanceM: r.basis.distanceM },
      },
      vo2max: v === null ? null : { elapsedS: Math.round(v) },
    };
  });
  return { windowDays, riegelExponent: RIEGEL_EXPONENT, vo2max: vo2, targets };
}
