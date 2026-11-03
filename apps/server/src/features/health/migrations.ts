import type { Migration } from '../../db/migrate';

/** Migrations of the health feature (ids are prefixed `health_`). */
export const healthMigrations: Migration[] = [
  {
    id: 'health_001_sleep_nights',
    up: /* sql */ `
      -- One row per sleep session: the main night of a (wake-up) day or a nap. Built by the health.sleep derive step
      -- from HKCategoryTypeIdentifierSleepAnalysis records (merged across sources, see sleep-builder.ts).
      CREATE TABLE health_sleep_nights (
        id INTEGER PRIMARY KEY,
        athlete_id INTEGER NOT NULL,
        day TEXT NOT NULL,                 -- local day of waking up
        kind TEXT NOT NULL,                -- 'night' | 'nap'
        bed_ts INTEGER NOT NULL,           -- first moment in bed / asleep
        wake_ts INTEGER NOT NULL,          -- last moment in bed / asleep
        tz_bed_min INTEGER NOT NULL DEFAULT 0,
        tz_wake_min INTEGER NOT NULL DEFAULT 0,
        onset_ts INTEGER,                  -- first asleep sample
        final_ts INTEGER,                  -- end of the last asleep sample
        in_bed_s INTEGER NOT NULL,
        asleep_s INTEGER NOT NULL,
        core_s INTEGER NOT NULL DEFAULT 0,
        deep_s INTEGER NOT NULL DEFAULT 0,
        rem_s INTEGER NOT NULL DEFAULT 0,
        unspec_s INTEGER NOT NULL DEFAULT 0,
        awake_s INTEGER NOT NULL DEFAULT 0,
        awakenings INTEGER NOT NULL DEFAULT 0,
        latency_s INTEGER,
        efficiency REAL,
        staged INTEGER NOT NULL DEFAULT 0,
        source TEXT,
        segments TEXT NOT NULL DEFAULT '[]', -- JSON [[offsetS, durationS, stageCode], …] relative to bed_ts
        UNIQUE (athlete_id, bed_ts)
      );
      CREATE INDEX ix_health_sleep_day ON health_sleep_nights(athlete_id, day, kind);
    `,
  },
  {
    id: 'health_002_ecg_stats',
    up: /* sql */ `
      -- Derived facts of ECG recordings (average heart rate from the R peaks, normalised classification).
      CREATE TABLE health_ecg_stats (
        ecg_id INTEGER PRIMARY KEY REFERENCES ecg_readings(id) ON DELETE CASCADE,
        athlete_id INTEGER NOT NULL,
        avg_hr REAL,
        duration_s REAL,
        class_key TEXT NOT NULL
      );
    `,
  },
  {
    id: 'health_003_external_nights',
    up: /* sql */ `
      -- Nights a device cloud reports as daily totals only (COROS: minutes per stage, no times). Written by the
      -- connectors; health.sleep merges them into health_sleep_nights (timed = 0: bed / wake time unknown).
      CREATE TABLE health_external_nights (
        athlete_id INTEGER NOT NULL,
        source TEXT NOT NULL,              -- 'COROS'
        day TEXT NOT NULL,                 -- local day of waking up
        asleep_s INTEGER NOT NULL,
        deep_s INTEGER NOT NULL DEFAULT 0,
        light_s INTEGER NOT NULL DEFAULT 0,
        rem_s INTEGER NOT NULL DEFAULT 0,
        awake_s INTEGER NOT NULL DEFAULT 0,
        nap_s INTEGER NOT NULL DEFAULT 0,
        avg_hr REAL, min_hr REAL, max_hr REAL,
        PRIMARY KEY (athlete_id, source, day)
      ) WITHOUT ROWID;
      ALTER TABLE health_sleep_nights ADD COLUMN timed INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE health_sleep_nights ADD COLUMN avg_hr REAL;
      ALTER TABLE health_sleep_nights ADD COLUMN min_hr REAL;
    `,
  },
];
