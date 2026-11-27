import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { get, openDb, run, type Db } from '../src/db/db';
import { migrate } from '../src/db/migrate';
import { coreMigrations } from '../src/db/schema';
import { DERIVE_VERSION } from '../src/derive/context';
import { runDerive } from '../src/derive/run';
import { features } from '../src/features';
import type { DeriveContext } from '../src/features/types';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-w2-derive-'));
  db = openDb(path.join(dir, 'cadence.db'));
  migrateAll(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const T0 = 1_780_000_000;

function workout(athleteId: number, key: string, version = DERIVE_VERSION): number {
  run(
    db,
    `INSERT INTO workouts (athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, duration_s, derived_version)
     VALUES (?, ?, 'HKWorkoutActivityTypeRunning', 'run', ?, ?, 120, 1800, ?)`,
    [athleteId, key, T0, T0 + 1800, version],
  );
  return get<{ id: number }>(db, 'SELECT id FROM workouts WHERE ext_key = ? AND athlete_id = ?', [key, athleteId])!.id;
}

describe('runDerive scope', () => {
  it("hands feature steps only the athlete's own workouts", async () => {
    run(db, "INSERT INTO athletes (id, name) VALUES (2, 'Other')");
    const own = workout(1, 'own');
    const foreign = workout(2, 'foreign');
    const seen: (number[] | 'all')[] = [];
    const spy = { id: 'test.spy', label: 'Spy', run: (ctx: DeriveContext) => void seen.push(ctx.workoutIds) };
    const feature = { name: 'test', deriveSteps: [spy] };
    features.push(feature);
    try {
      const d = await runDerive({ db, athleteId: 1, workoutIds: [foreign, own, 999_999], sinceDay: null, typeSince: new Map() });
      expect(d.workoutIds).toEqual([own]);
      expect(seen).toEqual([[own]]);
      // only foreign or unknown ids: nothing of this athlete changed
      const none = await runDerive({ db, athleteId: 1, workoutIds: [foreign, 999_999], sinceDay: null, typeSince: new Map() });
      expect(none.workoutIds).toEqual([]);
      expect(seen[1]).toEqual([]);
      // the other athlete's workout was not touched by athlete 1's derive
      expect(get<{ v: number }>(db, 'SELECT derived_version AS v FROM workouts WHERE id = ?', [foreign])!.v).toBe(DERIVE_VERSION);
    } finally {
      features.splice(features.indexOf(feature), 1);
    }
  });

  it('still adds workouts of an older derive version, but only of the athlete', async () => {
    run(db, "INSERT INTO athletes (id, name) VALUES (2, 'Other')");
    const own = workout(1, 'own');
    const stale = workout(1, 'stale', DERIVE_VERSION - 1);
    workout(2, 'foreign-stale', DERIVE_VERSION - 1);
    const d = await runDerive({ db, athleteId: 1, workoutIds: [own], sinceDay: null, typeSince: new Map(), includeFeatures: false });
    expect(d.workoutIds).toEqual([own, stale].sort((a, b) => a - b));
  });
});

describe('feature order', () => {
  it('runs the COROS rings step before the trophies that read the rings', async () => {
    const d = await runDerive({ db, athleteId: 1, workoutIds: 'all', sinceDay: null });
    const ids = d.steps.map((s) => s.id);
    expect(ids.indexOf('connect.coros')).toBeGreaterThan(ids.indexOf('core.daily-activity'));
    expect(ids.indexOf('connect.coros')).toBeLessThan(ids.indexOf('consistency.achievements'));
    expect(d.steps.filter((s) => s.error)).toEqual([]);
  });

  it('migrates a database created with the earlier feature order without running anything twice', () => {
    const old = openDb(path.join(dir, 'old.db'));
    try {
      const byName = new Map(features.map((f) => [f.name, f]));
      const earlier = ['activities', 'progress', 'consistency', 'maps', 'health', 'connect'].map((n) => byName.get(n)!);
      migrate(old, [...coreMigrations, ...earlier.flatMap((f) => f.migrations ?? [])]);
      expect(migrateAll(old)).toEqual([]);
      // a fresh database takes every migration once in the current order
      const fresh = openDb(':memory:');
      const ran = migrateAll(fresh);
      fresh.close();
      expect(new Set(ran).size).toBe(ran.length);
      expect(ran.indexOf('connect_001_activities')).toBeLessThan(ran.findIndex((id) => id.startsWith('consistency_')));
    } finally {
      old.close();
    }
  });
});
