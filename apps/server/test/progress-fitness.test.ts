import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { openDb, run, type Db } from '../src/db/db';
import { fitness } from '../src/features/progress/fitness';
import { addDays } from '../src/lib/time';

let db: Db;
const FIRST = '2025-01-06';

beforeAll(() => {
  db = openDb(':memory:');
  migrateAll(db);
  // 60 training days, every other day, with growing load
  for (let k = 0; k < 120; k += 2)
    run(
      db,
      `INSERT INTO daily_activity (athlete_id, day, sport, count, duration_s, moving_s, distance_m, elevation_m, energy_kcal, effort)
       VALUES (1, ?, 'run', 1, 3600, 3600, 10000, 50, 600, ?)`,
      [addDays(FIRST, k), 40 + k],
    );
});

afterAll(() => db?.close());

const LAST = addDays(FIRST, 118);

describe('fitness model far after the last activity', () => {
  it('extrapolates the decay exactly instead of building the model day by day', () => {
    const today = addDays(LAST, 200);
    const q = { sport: null, fromDay: addDays(LAST, -20), today };
    // the requested range ends before the extrapolation starts: every day is computed day by day
    const dense = fitness(db, 1, { ...q, toDay: addDays(LAST, 30) });
    // ends 200 days after the last activity: the days from LAST + 36 on are extrapolated
    const far = fitness(db, 1, { ...q, toDay: today });
    expect(far.days.slice(0, dense.days.length)).toEqual(dense.days);
    expect(far.current).toMatchObject({ day: today, load: 0, acwr: null, acwrStatus: null });
    // the decay continues smoothly through the switch from the model to the extrapolation
    const at = (day: string) => far.days.find((d) => d.day === day)!;
    const a = at(addDays(LAST, 35));
    const b = at(addDays(LAST, 36));
    expect(b.ctl).toBeCloseTo(a.ctl * (1 - 1 / 42), 1);
    expect(b.atl).toBeCloseTo(a.atl * (1 - 1 / 7), 1);
    expect(b.tsb).toBeCloseTo(b.ctl - b.atl, 1);
    expect(b.ramp).toBeLessThan(0);
    expect(far.current!.ctl).toBeLessThan(a.ctl);
  });

  it('answers a far future today or toDay without building millions of days', () => {
    const t0 = performance.now();
    const f = fitness(db, 1, { sport: null, fromDay: '2025-01-01', toDay: '2025-12-31', today: '9999-12-31' });
    expect(f.current).toMatchObject({ day: '9999-12-31', ctl: 0, atl: 0, load: 0, acwr: null });
    expect(f.days[0]!.day).toBe(FIRST); // the model starts at the first activity
    expect(f.days.at(-1)!.day).toBe('2025-12-31');
    const g = fitness(db, 1, { sport: null, fromDay: '9999-01-01', toDay: '9999-12-31', today: '2025-06-01' });
    expect(g.days).toHaveLength(365);
    expect(g.days.every((d) => d.ctl === 0 && d.load === 0)).toBe(true);
    expect(g.current?.day).toBe('2025-06-01');
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
