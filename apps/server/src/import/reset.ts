import { all, get, run, tx, type Db } from '../db/db';
import { features } from '../features';
import { clearScopes } from './scope';

/**
 * Tables that survive a reset: schema bookkeeping, the athlete row, preferences, the job log, and the tables
 * features declare as user-written (`Feature.keepOnReset`, e.g. goals and segments).
 */
const KEEP = new Set([
  '_migrations',
  'athletes',
  'settings',
  'import_jobs',
  ...features.flatMap((f) => f.keepOnReset ?? []),
]);

/**
 * Delete every imported and derived row of an athlete – core tables and feature tables alike (any table with an
 * `athlete_id` column; workout child tables go via ON DELETE CASCADE). Preferences (settings) and the tables in
 * KEEP are kept.
 * Returns the number of deleted rows per table.
 */
export function resetAthleteData(db: Db, athleteId: number): Record<string, number> {
  const tables = all<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((r) => r.name);
  const scoped = tables.filter(
    (t) =>
      !KEEP.has(t) &&
      all<{ name: string }>(db, `SELECT name FROM pragma_table_info(?)`, [t]).some(
        (c) => c.name === 'athlete_id',
      ),
  );
  const onlyAthlete = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM athletes')!.n <= 1;
  // children first so cascades have little left to do; workouts last
  scoped.sort((a, b) => Number(a === 'workouts') - Number(b === 'workouts'));
  const counts: Record<string, number> = {};
  tx(db, () => {
    db.exec('PRAGMA defer_foreign_keys = ON');
    for (const t of scoped) {
      // Without WHERE SQLite truncates the table instead of visiting every row (huge records tables).
      counts[t] = onlyAthlete
        ? run(db, `DELETE FROM "${t}"`).changes
        : run(db, `DELETE FROM "${t}" WHERE athlete_id = ?`, [athleteId]).changes;
    }
    if (onlyAthlete) {
      for (const t of [
        'workout_routes',
        'workout_streams',
        'workout_splits',
        'workout_events',
        'workout_activities',
        'workout_samples',
      ])
        if (tables.includes(t)) run(db, `DELETE FROM "${t}"`);
      for (const t of ['record_types', 'sources', 'devices'])
        if (tables.includes(t)) counts[t] = run(db, `DELETE FROM "${t}"`).changes;
    }
    for (const f of features) f.onReset?.(db, athleteId);
    run(db, "DELETE FROM settings WHERE athlete_id = ? AND key IN ('core.effortBasis')", [athleteId]);
    // pending derive changes describe data that is gone (the reset's own rederive rebuilds everything)
    clearScopes(db, athleteId);
    run(db, "DELETE FROM import_jobs WHERE athlete_id = ? AND status NOT IN ('queued', 'running')", [
      athleteId,
    ]);
    run(
      db,
      'UPDATE athletes SET birth_date = NULL, sex = NULL, blood_type = NULL, skin_type = NULL, updated_at = unixepoch() WHERE id = ?',
      [athleteId],
    );
  });
  return counts;
}
