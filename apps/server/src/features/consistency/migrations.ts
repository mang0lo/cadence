import type { Migration } from '../../db/migrate';

export const migrations: Migration[] = [
  {
    id: 'consistency_001_goals_achievements',
    up: /* sql */ `
      -- User-defined goals. Targets in canonical units (m, s, count). sport NULL = all sports.
      CREATE TABLE consistency_goals (
        id INTEGER PRIMARY KEY,
        athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
        period TEXT NOT NULL,            -- week | month | year
        sport TEXT,
        metric TEXT NOT NULL,            -- distance | time | elevation | activities | active_days
        target REAL NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX ix_consistency_goals ON consistency_goals(athlete_id, position);

      -- Trophies (derive step consistency.achievements): every catalog entry with progress, earned ones
      -- with the local day and activity that earned them.
      CREATE TABLE consistency_achievements (
        athlete_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        grp TEXT NOT NULL,
        kind TEXT NOT NULL,
        tier TEXT NOT NULL,
        sport TEXT,
        threshold REAL NOT NULL,
        name TEXT,
        ord INTEGER NOT NULL,            -- catalog order
        progress REAL NOT NULL DEFAULT 0,
        earned_day TEXT,
        workout_id INTEGER,
        first_seen_at INTEGER,           -- when an import first found it earned (NULL = initial computation)
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (athlete_id, key)
      ) WITHOUT ROWID;
    `,
  },
];
