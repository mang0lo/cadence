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
