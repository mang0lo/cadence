import { heartMetric } from '../../core/sources';
/** Year in review ("Wrapped"): totals, sports, months, highlights, rhythm, streaks, PRs, rings and health. */
import type {
  YearEffort,
  YearHealth,
  YearHealthValue,
  YearMonth,
  YearReview,
  YearSport,
  YearTotals,
  YearWorkoutRef,
} from '@cadence/shared';
import { all, get, type Db } from '../../db/db';
import { localDay } from '../../lib/time';
import { closed } from './achievements';
import {
  firstDataDay,
  loadActiveDays,
  loadDaily,
  loadRings,
  loadWorkoutsByDay,
  resolveDays,
  ringFractions,
  weekStartOfAthlete,
  yearsWithData,
  type LiteWorkout,
} from './data';
import { localParts, minDay, TZ_MARGIN_S, utcMidnight } from './days';
import type { DailyRow } from './goals';
import { longestRunWithin, longestWeekRunWithin } from './streaks';
import { ensureAchievements, readAchievements } from './trophies';

/** Headline distances shown as "fastest of the year". */
const FASTEST: Record<string, string[]> = {
  run: ['1k', '5k', '10k', 'half', 'marathon'],
  ride: ['20k', '40k', '100k'],
  swim: ['100m', '400m', '1k'],
};

export function totalsOf(rows: DailyRow[]): YearTotals {
  const days = new Set<string>();
  const t: YearTotals = { activities: 0, activeDays: 0, durationS: 0, distanceM: 0, elevationM: 0, energyKcal: 0, effort: 0 };
  for (const r of rows) {
    if (r.count <= 0) continue;
    days.add(r.day);
    t.activities += r.count;
    t.durationS += r.durationS;
    t.distanceM += r.distanceM;
    t.elevationM += r.elevationM;
    t.energyKcal += r.energyKcal;
    t.effort += r.effort;
  }
  t.activeDays = days.size;
  return t;
}

/** Same calendar date one year earlier (Feb 29 → Feb 28). */
export function sameDateYearBefore(day: string): string {
  const md = day.slice(5) === '02-29' ? '02-28' : day.slice(5);
  return `${Number(day.slice(0, 4)) - 1}-${md}`;
}

const ref = (w: LiteWorkout): YearWorkoutRef => ({
  id: w.id,
  name: w.name,
  sport: w.sport,
  startTs: w.start_ts,
  tzMin: w.tz_min,
  durationS: w.duration_s,
  distanceM: w.distance_m,
  elevationGainM: w.elevation_gain_m,
});

function maxBy<T>(list: T[], key: (x: T) => number | null): T | null {
  let best: T | null = null;
  let max = 0;
  for (const x of list) {
    const v = key(x);
    if (v !== null && v > max) {
      max = v;
      best = x;
    }
  }
  return best;
}

interface EffortRow {
  sport: string;
  effort: string;
  distance_m: number;
  elapsed_s: number;
  workout_id: number;
  start_ts: number;
  tz_min: number;
}

/** Fastest headline efforts of the year and all-time bests set during it. */
function efforts(
  db: Db,
  athleteId: number,
  from: string,
  to: string,
  byId: Map<number, LiteWorkout>,
): { fastest: YearEffort[]; prs: YearEffort[] } {
  const lo = utcMidnight(from) - TZ_MARGIN_S;
  const prior = new Map(
    all<{ sport: string; effort: string; best: number }>(
      db,
      `SELECT be.sport, be.effort, MIN(be.elapsed_s) AS best
       FROM workouts w JOIN best_efforts be ON be.workout_id = w.id
       WHERE w.athlete_id = ? AND w.hidden = 0 AND w.duplicate_of IS NULL AND w.start_ts < ?
       GROUP BY be.sport, be.effort`,
      [athleteId, lo],
    ).map((r) => [`${r.sport}|${r.effort}`, r.best]),
  );
  const rows = all<EffortRow>(
    db,
    `SELECT be.sport, be.effort, be.distance_m, be.elapsed_s, be.workout_id, w.start_ts, w.tz_min
     FROM workouts w JOIN best_efforts be ON be.workout_id = w.id
     WHERE w.athlete_id = ? AND w.hidden = 0 AND w.duplicate_of IS NULL AND w.start_ts >= ? AND w.start_ts < ?
     ORDER BY w.start_ts, w.id`,
    [athleteId, lo, utcMidnight(to) + 86400 + TZ_MARGIN_S],
  );
  const inYear = new Map<string, EffortRow[]>();
  for (const r of rows) {
    const k = `${r.sport}|${r.effort}`;
    const day = localDay(r.start_ts, r.tz_min);
    if (day < from) prior.set(k, Math.min(prior.get(k) ?? Infinity, r.elapsed_s));
    else if (day <= to) {
      let list = inYear.get(k);
      if (!list) inYear.set(k, (list = []));
      list.push(r);
    }
  }
  const fastest: YearEffort[] = [];
  const prs: YearEffort[] = [];
  for (const [k, list] of inYear) {
    const prev = prior.get(k) ?? null;
    let best: EffortRow | null = null;
    let running = prev ?? Infinity;
    let improvements = 0;
    let yearBest: EffortRow | null = null;
    for (const r of list) {
      if (!yearBest || r.elapsed_s < yearBest.elapsed_s) yearBest = r;
      if (r.elapsed_s < running) {
        running = r.elapsed_s;
        best = r;
        improvements++;
      }
    }
    const w = (r: EffortRow) => byId.get(r.workout_id);
    if (yearBest && FASTEST[yearBest.sport]?.includes(yearBest.effort) && w(yearBest))
      fastest.push({
        sport: yearBest.sport,
        effort: yearBest.effort,
        distanceM: yearBest.distance_m,
        elapsedS: yearBest.elapsed_s,
        previousBestS: prev,
        improvements,
        workout: ref(w(yearBest)!),
      });
    if (best && w(best))
      prs.push({
        sport: best.sport,
        effort: best.effort,
        distanceM: best.distance_m,
        elapsedS: best.elapsed_s,
        previousBestS: prev,
        improvements,
        workout: ref(w(best)!),
      });
  }
  const order = (a: YearEffort, b: YearEffort) => a.sport.localeCompare(b.sport) || a.distanceM - b.distanceM;
  return { fastest: fastest.sort(order), prs: prs.sort(order) };
}

const HK = (t: string) => `HKQuantityTypeIdentifier${t}`;

interface MetricAgg {
  avg: number | null;
  max: number | null;
  sum: number | null;
}

function metricAggs(db: Db, athleteId: number, from: string, to: string): Map<string, MetricAgg> {
  const metrics = [
    ...(['restingHr', 'hrv', 'vo2max', 'steps'] as const).map((m) => heartMetric(db, athleteId, m)),
    ...['ActiveEnergyBurned', 'FlightsClimbed'].map(HK),
  ];
  return new Map(
    all<{ metric: string } & MetricAgg>(
      db,
      `SELECT metric, AVG(value) AS avg, MAX(value) AS max, SUM(value) AS sum FROM daily_metrics
       WHERE athlete_id = ? AND metric IN (${metrics.map(() => '?').join(',')}) AND day >= ? AND day <= ?
       GROUP BY metric`,
      [athleteId, ...metrics, from, to],
    ).map((r) => [r.metric, r]),
  );
}

/**
 * Mean asleep minutes per night (waking up in [from, to]) from the sleep nights of the health feature: one source per
 * night, the whole night on its wake-up day, COROS nights included. Nights of an hour or less are left out.
 */
function sleepAvg(db: Db, athleteId: number, from: string, to: string): number | null {
  return (
    get<{ v: number | null }>(
      db,
      `SELECT AVG(asleep_s) / 60.0 AS v FROM health_sleep_nights
       WHERE athlete_id = ? AND kind = 'night' AND asleep_s > 3600 AND day >= ? AND day <= ?`,
      [athleteId, from, to],
    )?.v ?? null
  );
}

function health(db: Db, athleteId: number, range: [string, string], prevRange: [string, string]): YearHealth {
  const cur = metricAggs(db, athleteId, ...range);
  const prev = metricAggs(db, athleteId, ...prevRange);
  const hv = (metric: string, field: keyof MetricAgg): YearHealthValue => ({
    value: cur.get(metric.startsWith('COROS') ? metric : HK(metric))?.[field] ?? null,
    prev: prev.get(metric.startsWith('COROS') ? metric : HK(metric))?.[field] ?? null,
  });
  const heart = (m: 'restingHr' | 'hrv' | 'vo2max' | 'steps') => {
    const id = heartMetric(db, athleteId, m);
    return id.startsWith('COROS') ? id : id.replace('HKQuantityTypeIdentifier', '');
  };
  const best = get<{ day: string; value: number }>(
    db,
    `SELECT day, value FROM daily_metrics WHERE athlete_id = ? AND metric = ? AND day >= ? AND day <= ?
     ORDER BY value DESC LIMIT 1`,
    [athleteId, heartMetric(db, athleteId, 'steps'), ...range],
  );
  const weight = (dir: 'ASC' | 'DESC') =>
    get<{ value: number }>(
      db,
      `SELECT value FROM daily_metrics WHERE athlete_id = ? AND metric = ? AND day >= ? AND day <= ?
       ORDER BY day ${dir} LIMIT 1`,
      [athleteId, HK('BodyMass'), ...range],
    )?.value ?? null;
  return {
    restingHr: hv(heart('restingHr'), 'avg'),
    hrv: hv(heart('hrv'), 'avg'),
    vo2max: hv(heart('vo2max'), 'max'),
    stepsPerDay: hv(heart('steps'), 'avg'),
    stepsTotal: cur.get(heartMetric(db, athleteId, 'steps'))?.sum ?? null,
    bestStepsDay: best ?? null,
    sleepPerNightMin: { value: sleepAvg(db, athleteId, ...range), prev: sleepAvg(db, athleteId, ...prevRange) },
    activeEnergyKcal: hv('ActiveEnergyBurned', 'sum'),
    flights: hv('FlightsClimbed', 'sum'),
    weightStart: weight('ASC'),
    weightEnd: weight('DESC'),
  };
}

export function yearReview(db: Db, athleteId: number, year: number, today?: string): YearReview {
  const weekStart = weekStartOfAthlete(db, athleteId);
  const days = resolveDays(db, athleteId, today);
  const firstDay = firstDataDay(db, athleteId);
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const complete = days.asOf >= to;
  const end = complete ? to : minDay(to, days.asOf);
  const prevFrom = `${year - 1}-01-01`;
  const prevTo = complete ? `${year - 1}-12-31` : sameDateYearBefore(end);

  const rows = loadDaily(db, athleteId, from, to);
  const prevRows = loadDaily(db, athleteId, prevFrom, prevTo);

  const sports = new Map<string, YearSport>();
  for (const r of rows) {
    const s = sports.get(r.sport) ?? { sport: r.sport, count: 0, durationS: 0, distanceM: 0, elevationM: 0 };
    s.count += r.count;
    s.durationS += r.durationS;
    s.distanceM += r.distanceM;
    s.elevationM += r.elevationM;
    sports.set(r.sport, s);
  }
  const months: YearMonth[] = Array.from({ length: 12 }, (_, i) => {
    const month = `${year}-${String(i + 1).padStart(2, '0')}`;
    const t = totalsOf(rows.filter((r) => r.day.startsWith(month)));
    return {
      month,
      count: t.activities,
      durationS: t.durationS,
      distanceM: t.distanceM,
      elevationM: t.elevationM,
      activeDays: t.activeDays,
    };
  });
  const topMonth = maxBy(months, (m) => m.durationS);

  const workouts = loadWorkoutsByDay(db, athleteId, from, to);
  const byId = new Map(workouts.map((w) => [w.id, w]));
  const weekdays = Array<number>(7).fill(0);
  const hours = Array<number>(24).fill(0);
  for (const w of workouts) {
    const p = localParts(w.start_ts, w.tz_min);
    weekdays[p.weekday]!++;
    hours[p.hour]!++;
  }

  const active = loadActiveDays(db, athleteId);
  const daily = longestRunWithin(active, from, to);
  const weekly = longestWeekRunWithin(active, from, to, weekStart);

  const ringRows = loadRings(db, athleteId, from, to).map(ringFractions);
  const rings = ringRows.length
    ? {
        days: ringRows.length,
        move: ringRows.filter((f) => closed(f.move)).length,
        exercise: ringRows.filter((f) => closed(f.exercise)).length,
        stand: ringRows.filter((f) => closed(f.stand)).length,
        all: ringRows.filter((f) => closed(f.move) && closed(f.exercise) && closed(f.stand)).length,
      }
    : null;

  ensureAchievements(db, athleteId);
  const { fastest, prs } = efforts(db, athleteId, from, to, byId);

  return {
    year,
    years: yearsWithData(firstDay, days.asOf),
    today: days.today,
    asOf: days.asOf,
    firstDay,
    complete,
    totals: totalsOf(rows),
    previous: prevRows.some((r) => r.count > 0) ? totalsOf(prevRows) : null,
    bySport: [...sports.values()].sort((a, b) => b.durationS - a.durationS || b.count - a.count),
    months,
    topMonth: topMonth && topMonth.count > 0 ? topMonth : null,
    longest: (() => {
      const w = maxBy(workouts, (x) => x.distance_m);
      return w ? ref(w) : null;
    })(),
    longestTime: (() => {
      const w = maxBy(workouts, (x) => x.duration_s);
      return w ? ref(w) : null;
    })(),
    biggestClimb: (() => {
      const w = maxBy(workouts, (x) => x.elevation_gain_m);
      return w ? ref(w) : null;
    })(),
    first: workouts[0] ? ref(workouts[0]) : null,
    fastest,
    prs,
    weekdays,
    hours,
    streaks: { daily, weekly },
    rings,
    trophies: readAchievements(db, athleteId, from, to),
    health: health(db, athleteId, [from, end], [prevFrom, prevTo]),
  };
}
