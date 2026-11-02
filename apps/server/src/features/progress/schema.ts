import type { Migration } from '../../db/migrate';

/**
 * Tables of the progress feature.
 *
 * progress_workout_metrics – per-workout values that need streams or raw records and are therefore
 * precomputed by the derive step `progress.workout-metrics` (and filled lazily for workouts derived before
 * this feature existed):
 *   - running dynamics averages from records during the workout (stride length, ground contact time,
 *     vertical oscillation),
 *   - aerobic decoupling (Pa:HR) from the streams,
 *   - hr_speed: JSON {lo, s, d} = moving seconds and meters per integer bpm from bpm `lo`
 *     (pace inside any heart-rate band = Σd / Σs over the band, see math.ts).
 */
export const progressMigrations: Migration[] = [
  {
    id: 'progress_001_workout_metrics',
    up: /* sql */ `
      CREATE TABLE progress_workout_metrics (
        workout_id INTEGER PRIMARY KEY REFERENCES workouts(id) ON DELETE CASCADE,
        athlete_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        source_updated_at INTEGER NOT NULL,  -- workouts.updated_at the row was computed from
        stride_m REAL,
        gct_ms REAL,
        vo_m REAL,
        decoupling_pct REAL,
        hr_speed TEXT
      );
      CREATE INDEX ix_progress_workout_metrics_athlete ON progress_workout_metrics(athlete_id);
    `,
  },
];
