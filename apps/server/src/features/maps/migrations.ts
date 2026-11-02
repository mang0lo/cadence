import type { Migration } from '../../db/migrate';

/**
 * Tables of the maps feature. Every table carries athlete_id (the import "reset" wipes feature tables by that
 * column). Derived tables can always be rebuilt with "rebuild analysis"; user data (route names, segments) is kept
 * in its own tables / columns so a rebuild never loses it.
 */
export const migrations: Migration[] = [
  {
    id: 'maps_001_tiles',
    up: /* sql */ `
      -- Slippy-map tiles (zoom 14 and 17) every workout passed through. Hidden / duplicate workouts keep their rows;
      -- they are filtered when reading, so toggling "hidden" never needs a rebuild.
      CREATE TABLE maps_workout_tiles (
        athlete_id INTEGER NOT NULL,
        z INTEGER NOT NULL,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
        PRIMARY KEY (athlete_id, z, x, y, workout_id)
      ) WITHOUT ROWID;
      CREATE INDEX ix_maps_workout_tiles_workout ON maps_workout_tiles(workout_id);
    `,
  },
];
