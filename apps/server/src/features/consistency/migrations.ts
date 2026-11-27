import { all, json, run } from '../../db/db';
import type { Migration } from '../../db/migrate';
import { parseDay } from '../../lib/time';
import { plusDays, weekdayOf } from './days';

/** A check mark day of a weekly goal written as the first day of its week (a Sunday or a Monday). */
const isWeekStart = (day: string) => parseDay(day) !== null && weekdayOf(day) <= 1;

export const migrations: Migration[] = [
  {
    id: 'consistency_001_goals_achievements',
    up: /* sql */ `
      -- User-defined goals. Targets in canonical units (m, s, count). sport NULL = all sports.
      CREATE TABLE consistency_goals (
        id INTEGER PRIMARY KEY,
        athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
        period TEXT NOT NULL,            -- day | week | month | year
        sport TEXT,
        metric TEXT NOT NULL,            -- distance | longest | time | elevation | calories | activities | active_days
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
  {
    id: 'consistency_002_goal_checks',
    up: /* sql */ `
      -- Goals checked off by hand (something was done but not tracked): one row per goal and period, keyed by a
      -- local day inside the period (its first day; for weeks its fourth day since consistency_003, so that either
      -- week start finds the week it was set for).
      CREATE TABLE consistency_goal_checks (
        goal_id INTEGER NOT NULL REFERENCES consistency_goals(id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (goal_id, day)
      ) WITHOUT ROWID;
    `,
  },
  {
    // Check marks of weekly goals were keyed by the first day of the week: a Sunday mark belongs to the previous
    // Monday week, so switching the week start moved it a week back. Key them by the middle of the week (+3 days),
    // in the table and in the goals mirror of the settings (consistency.goalsBackup).
    id: 'consistency_003_week_checks_midweek',
    up: (db) => {
      const weekly = all<{ goal_id: number; day: string }>(
        db,
        `SELECT c.goal_id, c.day FROM consistency_goal_checks c JOIN consistency_goals g ON g.id = c.goal_id
         WHERE g.period = 'week'`,
      );
      for (const c of weekly)
        if (isWeekStart(c.day))
          run(db, 'UPDATE OR IGNORE consistency_goal_checks SET day = ? WHERE goal_id = ? AND day = ?', [
            plusDays(c.day, 3),
            c.goal_id,
            c.day,
          ]);
      for (const r of all<{ athlete_id: number; value: string }>(
        db,
        "SELECT athlete_id, value FROM settings WHERE key = 'consistency.goalsBackup'",
      )) {
        const list = json<{ period?: unknown; checks?: unknown }[] | null>(r.value, null);
        if (!Array.isArray(list)) continue;
        let changed = false;
        for (const g of list) {
          if (g?.period !== 'week' || !Array.isArray(g.checks)) continue;
          g.checks = g.checks.map((d: unknown) => {
            if (typeof d !== 'string' || !isWeekStart(d)) return d;
            changed = true;
            return plusDays(d, 3);
          });
        }
        if (changed)
          run(db, "UPDATE settings SET value = ? WHERE athlete_id = ? AND key = 'consistency.goalsBackup'", [
            JSON.stringify(list),
            r.athlete_id,
          ]);
      }
    },
  },
];
