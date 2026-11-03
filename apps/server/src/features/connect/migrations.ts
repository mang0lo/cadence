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
];
