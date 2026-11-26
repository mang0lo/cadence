import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { updateSettings } from '../src/core/settings';
import { all, openDb, run, type Db } from '../src/db/db';
import { detectDuplicates, resolveDuplicates, type DupCandidate } from '../src/derive/duplicates';

const T0 = 1_780_000_000;
const MIN = 60;

interface Spec {
  /** Minutes after T0. */
  from: number;
  to: number;
  sport?: string;
  source?: string | null;
  route?: boolean;
  hr?: boolean;
  /** The device's own FIT file. */
  fit?: boolean;
  hidden?: boolean;
}

/** A workout as duplicate detection sees it (Apple Watch run with route and HR unless said otherwise). */
function cand(id: number, s: Spec): DupCandidate {
  return {
    id,
    start_ts: T0 + s.from * MIN,
    end_ts: T0 + s.to * MIN,
    sport: s.sport ?? 'run',
    source_name: s.source === undefined ? 'Apple Watch von Hannes' : s.source,
    has_route: (s.route ?? true) ? 1 : 0,
    has_hr: (s.hr ?? true) ? 1 : 0,
    distance_m: 5000,
    energy_kcal: 300,
    from_device: s.fit ? 1 : 0,
  };
}

/** duplicate_of per id, as a plain object for readable assertions. */
function resolve(specs: Spec[], preferDevice = false): Record<number, number | null> {
  const out = resolveDuplicates(
    specs.map((s, i) => cand(i + 1, s)),
    preferDevice,
  );
  return Object.fromEntries([...out].sort((a, b) => a[0] - b[0]));
}

const thirdParty = (from: number, to: number, source: string, o: Partial<Spec> = {}): Spec => ({
  from,
  to,
  source,
  route: false,
  hr: false,
  ...o,
});

describe('resolveDuplicates', () => {
  it('marks a third-party copy of a Watch workout (Strava writing back to Health)', () => {
    expect(resolve([{ from: 0, to: 60 }, thirdParty(0, 60, 'Strava')])).toEqual({ 1: null, 2: 1 });
  });

  it('keeps one original among three copies of a session', () => {
    expect(
      resolve([thirdParty(0, 61, 'Strava'), { from: 0, to: 60 }, thirdParty(1, 60, 'Garmin Connect')]),
    ).toEqual({ 1: 2, 2: null, 3: 2 });
  });

  it('keeps both halves of a split Watch session when another source recorded it whole', () => {
    // Watch stopped at a café (two workouts), the bike computer recorded the whole ride
    expect(
      resolve([{ from: 0, to: 30 }, { from: 31, to: 60 }, thirdParty(0, 60, 'ELEMNT BOLT', { route: true })]),
    ).toEqual({ 1: null, 2: null, 3: 1 });
    // a Watch warm-up and main run, plus a phone app that recorded both: the copy points to the main run
    expect(resolve([{ from: 0, to: 12 }, { from: 14, to: 60 }, thirdParty(0, 60, 'Nike Run Club')])).toEqual({
      1: null,
      2: null,
      3: 2,
    });
  });

  it('keeps both FIT halves when the watch is preferred and Apple Health has the whole session', () => {
    const fit = { source: 'COROS PACE 3', fit: true };
    expect(resolve([{ from: 0, to: 30, ...fit }, { from: 31, to: 60, ...fit }, { from: 0, to: 60 }], true)).toEqual({
      1: null,
      2: null,
      3: 1,
    });
  });

  it('marks both halves when the whole-session copy is the preferred one', () => {
    const fit = { source: 'COROS PACE 3', fit: true };
    expect(resolve([{ from: 0, to: 30 }, { from: 31, to: 60 }, { from: 0, to: 60, ...fit }], true)).toEqual({
      1: 3,
      2: 3,
      3: null,
    });
  });

  it('follows Settings → My watch between the Apple copy and the FIT copy', () => {
    const specs: Spec[] = [{ from: 0, to: 30, source: 'COROS' }, { from: 0, to: 30, source: 'COROS PACE 3', fit: true }];
    expect(resolve(specs, false)).toEqual({ 1: null, 2: 1 });
    expect(resolve(specs, true)).toEqual({ 1: 2, 2: null });
  });

  it('keeps a long workout that a shorter preferred copy covers less than halfway', () => {
    // the watch's file stops after 20 minutes (battery), Apple Health has the whole hour: losing 40 minutes would be
    // worse than counting 20 twice
    expect(resolve([{ from: 0, to: 20, source: 'COROS PACE 3', fit: true }, { from: 0, to: 60 }], true)).toEqual({
      1: null,
      2: null,
    });
    // covered at least halfway: a copy
    expect(resolve([{ from: 0, to: 30, source: 'COROS PACE 3', fit: true }, { from: 0, to: 60 }], true)).toEqual({
      1: null,
      2: 1,
    });
  });

  it('never merges different sports, the same source or zero-length workouts', () => {
    expect(resolve([{ from: 0, to: 60 }, thirdParty(0, 60, 'Strava', { sport: 'ride' })])).toEqual({ 1: null, 2: null });
    expect(resolve([{ from: 0, to: 60 }, { from: 0, to: 60, route: false }])).toEqual({ 1: null, 2: null });
    expect(resolve([{ from: 0, to: 60 }, thirdParty(30, 30, 'Strava')])).toEqual({ 1: null, 2: null });
    // a missing source counts as one source ('')
    expect(resolve([{ from: 0, to: 60, source: null }, thirdParty(0, 60, '', { source: null })])).toEqual({
      1: null,
      2: null,
    });
  });

  it('does not depend on the order of the input', () => {
    const specs: Spec[] = [
      { from: 0, to: 30 },
      { from: 31, to: 60 },
      thirdParty(0, 60, 'Strava'),
      { from: 600, to: 660 },
      thirdParty(601, 659, 'Runkeeper'),
    ];
    const cands = specs.map((s, i) => cand(i + 1, s));
    const a = resolveDuplicates(cands, false);
    const b = resolveDuplicates([...cands].reverse(), false);
    expect([...b].sort((x, y) => x[0] - y[0])).toEqual([...a].sort((x, y) => x[0] - y[0]));
    expect(a.get(5)).toBe(4);
  });
});

describe('detectDuplicates', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    migrateAll(db);
  });
  afterEach(() => db.close());

  function insert(s: Spec): number {
    const c = cand(0, s);
    return run(
      db,
      `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, duration_s, source_name,
         has_route, avg_hr, distance_m, energy_kcal, hidden)
       VALUES (1, ?, 'HKWorkoutActivityTypeOther', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `${s.fit ? 'fit:1' : 'hk'}:${c.start_ts}:${c.end_ts}:${c.source_name}:${Math.random()}`,
        c.sport,
        c.start_ts,
        c.end_ts,
        c.end_ts - c.start_ts,
        c.source_name,
        c.has_route,
        c.has_hr ? 140 : null,
        c.distance_m,
        c.energy_kcal,
        s.hidden ? 1 : 0,
      ],
    ).lastInsertRowid;
  }
  const dupOf = () =>
    Object.fromEntries(
      all<{ id: number; duplicate_of: number | null }>(db, 'SELECT id, duplicate_of FROM workouts ORDER BY id').map(
        (r) => [r.id, r.duplicate_of],
      ),
    );

  it('keeps both halves of a split session visible (full run and import of the copy)', () => {
    const a = insert({ from: 0, to: 30 });
    const c = insert({ from: 31, to: 60 });
    const b = insert(thirdParty(0, 60, 'Strava'));
    expect(detectDuplicates(db, 1, [b])).toBe(1);
    expect(dupOf()).toEqual({ [a]: null, [c]: null, [b]: a });
    expect(detectDuplicates(db, 1, 'all')).toBe(1);
    expect(dupOf()).toEqual({ [a]: null, [c]: null, [b]: a });
  });

  it('follows the watch preference when it changes', () => {
    const apple = insert({ from: 0, to: 30, source: 'COROS' });
    const fit = insert({ from: 0, to: 30, source: 'COROS PACE 3', fit: true });
    detectDuplicates(db, 1, [apple, fit]);
    expect(dupOf()).toEqual({ [apple]: null, [fit]: apple });
    updateSettings(db, 1, { watch: 'coros' });
    detectDuplicates(db, 1, 'all');
    expect(dupOf()).toEqual({ [apple]: fit, [fit]: null });
  });

  it('keeps the marks of workouts the new one does not overlap itself', () => {
    updateSettings(db, 1, { watch: 'coros' });
    const fit = insert({ from: 0, to: 60, source: 'COROS PACE 3', fit: true });
    const watch = insert({ from: 0, to: 120 });
    detectDuplicates(db, 1, [fit, watch]);
    expect(dupOf()).toEqual({ [fit]: null, [watch]: fit });
    // a Strava copy of the second hour overlaps the Watch workout but not the watch's file
    const strava = insert(thirdParty(61, 120, 'Strava'));
    detectDuplicates(db, 1, [strava]);
    expect(dupOf()).toEqual({ [fit]: null, [watch]: fit, [strava]: null });
    detectDuplicates(db, 1, 'all');
    expect(dupOf()).toEqual({ [fit]: null, [watch]: fit, [strava]: null });
  });

  it('gives the same result incrementally as a full run, in any import order', () => {
    updateSettings(db, 1, { watch: 'coros' });
    const specs: Spec[] = [
      { from: 0, to: 120 },
      { from: 0, to: 60, source: 'COROS PACE 3', fit: true },
      thirdParty(61, 120, 'Strava'),
      thirdParty(100, 180, 'Runkeeper'),
      { from: 170, to: 200, source: 'COROS PACE 3', fit: true },
    ];
    const permutations = (xs: number[]): number[][] =>
      xs.length ? xs.flatMap((x) => permutations(xs.filter((y) => y !== x)).map((p) => [x, ...p])) : [[]];
    const orders = permutations(specs.map((_, k) => k));
    expect(orders).toHaveLength(120);
    for (const order of orders) {
      run(db, 'DELETE FROM workouts');
      for (const k of order) detectDuplicates(db, 1, [insert(specs[k]!)]);
      const incremental = dupOf();
      detectDuplicates(db, 1, 'all');
      expect(dupOf(), `import order ${order.join(',')}`).toEqual(incremental);
    }
  });
});
