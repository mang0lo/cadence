import type { Migration } from '../../db/migrate';

/**
 * Tables of the progress feature.
 *
 * progress_workout_metrics – per-workout values that need streams or raw records and are therefore
 * precomputed by the derive step `progress.workout-caches` (derive.ts; filled lazily for workouts derived before
 * this feature existed):
 *   - running dynamics averages from records during the workout (stride length, ground contact time,
 *     vertical oscillation),
 *   - hr_speed: JSON {lo, s, d} = moving seconds and meters per integer bpm from bpm `lo`
 *     (pace inside any heart-rate band = Σd / Σs over the band, see math.ts).
 *   Aerobic decoupling and the efficiency factor are read from activities_analysis (one definition with the activity
 *   page); the decoupling_pct column of migration 001 is dropped by 003.
 *
 * progress_power_bests – per workout with a power stream: the best average power (W) for each standard duration
 * (PROGRESS_POWER_DURATIONS) the workout covers within one track part, with the local day and the sport, so the
 * power curve of any period is a MAX per duration (derive step `progress.workout-caches`, see power-curve.ts).
 * progress_power_state – one row per processed workout (also those without power), so the lazy fill knows what
 * is done; `source_updated_at` = workouts.updated_at the rows were computed from.
 * Rows exist for hidden and duplicate workouts too; the queries exclude them by joining workouts.
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
  {
    id: 'progress_002_power_curve',
    up: /* sql */ `
      CREATE TABLE progress_power_state (
        workout_id INTEGER PRIMARY KEY REFERENCES workouts(id) ON DELETE CASCADE,
        athlete_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        source_updated_at INTEGER NOT NULL,  -- workouts.updated_at the rows were computed from
        power_s INTEGER NOT NULL             -- seconds with power (0 = no power data)
      );
      CREATE INDEX ix_progress_power_state_athlete ON progress_power_state(athlete_id);
      CREATE TABLE progress_power_bests (
        workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
        athlete_id INTEGER NOT NULL,
        sport TEXT NOT NULL,
        day TEXT NOT NULL,                   -- local start day of the workout
        duration_s INTEGER NOT NULL,
        watts REAL NOT NULL,                 -- best average power over duration_s
        offset_s REAL NOT NULL,              -- start of that window, seconds after the workout start
        PRIMARY KEY (workout_id, duration_s)
      ) WITHOUT ROWID;
      CREATE INDEX ix_progress_power_bests_day ON progress_power_bests(athlete_id, sport, day);
      CREATE INDEX ix_progress_power_bests_duration ON progress_power_bests(athlete_id, sport, duration_s, day);
    `,
  },
  {
    // decoupling comes from the activity analysis now (activities_analysis.decoupling_pct)
    id: 'progress_003_drop_decoupling',
    up: /* sql */ `
      ALTER TABLE progress_workout_metrics DROP COLUMN decoupling_pct;
    `,
  },
];
