import type { Migration } from '../../db/migrate';

export const connectMigrations: Migration[] = [
  {
    id: 'connect_001_activities',
    up: /* sql */ `
      -- Activities seen in a vendor cloud (COROS …): what was fetched, what failed. The FIT files themselves are
      -- cached in DATA_DIR/connect/<provider>/ and imported like any FIT file.
      CREATE TABLE connect_activities (
        athlete_id INTEGER NOT NULL,
        provider TEXT NOT NULL,          -- 'coros'
        remote_id TEXT NOT NULL,         -- COROS labelId
        start_ts INTEGER,
        sport_type INTEGER,              -- vendor sport code
        name TEXT,
        device TEXT,
        file TEXT,                       -- cached FIT file
        status TEXT NOT NULL,            -- 'fetched' | 'failed'
        error TEXT,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (athlete_id, provider, remote_id)
      ) WITHOUT ROWID;
    `,
  },
  {
    id: 'connect_002_activity_retries',
    up: /* sql */ `
      -- Fetched: the import job that got the cached file ('imported' = its workout exists). A file whose job failed
      -- or was cancelled, or that never reached a job (sync cut off), goes into the next sync's job again.
      ALTER TABLE connect_activities ADD COLUMN job_id TEXT;
      ALTER TABLE connect_activities ADD COLUMN import_attempts INTEGER NOT NULL DEFAULT 0;
      -- Failed: downloads tried in a row; normal syncs retry from next_retry_at on (backoff), a full sync always.
      ALTER TABLE connect_activities ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE connect_activities ADD COLUMN next_retry_at INTEGER;
      -- earlier versions never retried them: once more with the next sync
      UPDATE connect_activities SET attempts = 1, next_retry_at = 0 WHERE status = 'failed';
    `,
  },
  {
    // COROS' daily steps, calories and active minutes are totals: weeks and months add up, today is incomplete
    id: 'connect_003_daily_totals',
    up: /* sql */ `
      UPDATE record_types SET aggregation = 'sum'
      WHERE identifier IN ('COROSSteps', 'COROSCalories', 'COROSActiveMinutes');
      UPDATE daily_metrics SET min = NULL, max = NULL
      WHERE athlete_id IN (SELECT id FROM athletes) AND metric IN ('COROSSteps', 'COROSCalories', 'COROSActiveMinutes');
    `,
  },
  {
    id: 'connect_004_rings',
    up: /* sql */ `
      -- The COROS app's daily rings as COROS reports them (calories → Move, active time → Exercise). activity_summaries
      -- shows them where Apple has no rings or the watch is preferred; 'replaced' keeps the Apple row a COROS row
      -- replaced (JSON), so preferring Apple again restores it.
      CREATE TABLE connect_rings (
        athlete_id INTEGER NOT NULL,
        provider TEXT NOT NULL,          -- 'coros'
        day TEXT NOT NULL,
        active_energy_kcal REAL,
        active_energy_goal_kcal REAL,
        exercise_min REAL,
        exercise_goal_min REAL,
        replaced TEXT,
        PRIMARY KEY (athlete_id, provider, day)
      ) WITHOUT ROWID;
    `,
  },
];
