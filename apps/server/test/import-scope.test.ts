import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { openDb, run, tx, type Db } from '../src/db/db';
import {
  ChangeScope,
  claimScope,
  notePending,
  pendingScope,
  releaseClaim,
  scopeFromOptions,
} from '../src/import/scope';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-scope-'));
  db = openDb(path.join(dir, 'cadence.db'));
  migrateAll(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const DAY = 86400;
const T = 1_780_000_000; // 2026-05-28 20:26 UTC

describe('change scope', () => {
  it('collects record types, workouts and days', () => {
    const s = new ChangeScope();
    expect(s.empty).toBe(true);
    expect(s.sinceDay('2026-11-26')).toBe('2026-11-26');
    expect(s.typeSince()).toEqual(new Map());
    s.noteRecord(7, T + 5 * DAY);
    s.noteRecord(7, T + 2 * DAY);
    s.noteRecord(9, T + 9 * DAY);
    s.noteWorkout(3, T + 4 * DAY);
    s.noteWorkout(1);
    expect(s.workoutIds()).toEqual([1, 3]);
    expect(s.typeSince()).toEqual(new Map([[7, T + 2 * DAY], [9, T + 9 * DAY]]));
    // one day of margin before the UTC day of the earliest change
    expect(s.sinceDay('2026-11-26')).toBe('2026-05-29');
    // a workout noted without its start (new route) can be earlier
    expect(s.sinceDay('2026-11-26', T - 10 * DAY)).toBe('2026-05-17');
  });

  it('survives the round trip through the settings JSON', () => {
    const s = new ChangeScope();
    s.noteRecord(7, T);
    s.noteWorkout(3, T + DAY);
    s.noteDay(T - DAY);
    s.noteSinceDay('2026-05-01');
    const back = ChangeScope.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
    expect(back.toJSON()).toEqual(s.toJSON());
    expect(back.sinceDay('x')).toBe('2026-05-01');
    expect(ChangeScope.fromJSON(null).empty).toBe(true);
    expect(ChangeScope.fromJSON({ workouts: [1, 'x' as unknown as number], types: { 2: 5 } }).toJSON()).toEqual({
      workouts: [1],
      types: { 2: 5 },
      minTs: 5,
    });
  });

  it('merges, with everything absorbing the rest', () => {
    const a = new ChangeScope();
    a.noteRecord(7, T);
    const b = new ChangeScope();
    b.noteRecord(7, T - DAY);
    b.noteWorkout(2, T);
    expect(a.merge(b).toJSON()).toEqual({ workouts: [2], types: { 7: T - DAY }, minTs: T - DAY });
    const all = scopeFromOptions({});
    expect(all.all).toBe(true);
    expect(a.merge(all).workoutIds()).toBe('all');
    expect(a.sinceDay('x')).toBeNull();
    expect(a.typeSince()).toBeNull();
  });

  it('tells what another scope does not cover yet', () => {
    const known = new ChangeScope();
    known.noteWorkout(1, T);
    known.noteRecord(7, T);
    const s = new ChangeScope();
    s.noteWorkout(1);
    s.noteWorkout(2);
    s.noteRecord(7, T + DAY);
    s.noteRecord(8, T + DAY);
    expect(s.without(known).toJSON()).toEqual({ workouts: [2], types: { 8: T + DAY } });
    expect(s.without(scopeFromOptions({ workoutIds: 'all' })).empty).toBe(true);
  });

  it('reads rederive options', () => {
    // a subset rederive recomputes every record type from its day (the old meaning) …
    const s = scopeFromOptions({ workoutIds: [5], sinceDay: '2026-05-01' });
    expect(s.workoutIds()).toEqual([5]);
    expect(s.typeSince()).toBeNull();
    expect(s.sinceDay('x')).toBe('2026-05-01');
    expect(scopeFromOptions({ workoutIds: [5], sinceDay: null }).sinceDay('x')).toBeNull();
    // … unless no health record changed (an edited workout)
    const w = scopeFromOptions({ workoutIds: [5], sinceDay: '2026-05-01', records: false });
    expect(w.typeSince()).toEqual(new Map());
    expect(w.sinceDay('x')).toBe('2026-05-01');
    expect(scopeFromOptions({ workoutIds: [], sinceDay: null, records: false }).empty).toBe(true);
  });
});

describe('pending scope in the database', () => {
  const note = (fn: (s: ChangeScope) => void, athleteId = 1) => {
    const s = new ChangeScope();
    fn(s);
    notePending(db, athleteId, s);
  };

  it('is taken over by a derive and dropped only after it succeeded', () => {
    run(db, 'INSERT INTO athletes (id) VALUES (2)');
    note((s) => s.noteRecord(7, T));
    note((s) => s.noteWorkout(3, T + DAY));
    note((s) => s.noteWorkout(4), 2);
    let c = claimScope(db, 1);
    expect(c.toJSON()).toEqual({ workouts: [3], types: { 7: T }, minTs: T });
    // the derive failed: a later change and the claim come together in the next derive
    note((s) => s.noteRecord(8, T - DAY));
    expect(pendingScope(db, 1).toJSON()).toEqual({ workouts: [3], types: { 7: T, 8: T - DAY }, minTs: T - DAY });
    c = claimScope(db, 1, scopeFromOptions({ workoutIds: [9], sinceDay: null, records: false }));
    expect(c.toJSON()).toEqual({ workouts: [3, 9], types: { 7: T, 8: T - DAY }, minTs: T - DAY });
    releaseClaim(db, 1);
    expect(pendingScope(db, 1).empty).toBe(true);
    // per athlete
    expect(pendingScope(db, 2).workoutIds()).toEqual([4]);
  });

  it('rolls back with the data it describes', () => {
    expect(() =>
      tx(db, () => {
        note((s) => s.noteWorkout(3, T));
        throw new Error('disk full');
      }),
    ).toThrow('disk full');
    expect(pendingScope(db, 1).empty).toBe(true);
    // an empty change writes nothing
    note(() => {});
    expect(pendingScope(db, 1).empty).toBe(true);
  });
});
