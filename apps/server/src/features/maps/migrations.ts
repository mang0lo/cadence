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
  {
    id: 'maps_002_routes',
    up: /* sql */ `
      -- Shape signature of every workout with a GPS track (see route-shapes.ts) and the route it was assigned to.
      CREATE TABLE maps_workout_geo (
        workout_id INTEGER PRIMARY KEY REFERENCES workouts(id) ON DELETE CASCADE,
        athlete_id INTEGER NOT NULL,
        length_m REAL NOT NULL,
        sig BLOB NOT NULL,               -- Float64Array: lat0, lon0, lat1, lon1, … resampled by arc length
        route_id INTEGER                 -- maps_routes.id (NULL until clustered)
      );
      CREATE INDEX ix_maps_workout_geo_route ON maps_workout_geo(route_id);
      CREATE INDEX ix_maps_workout_geo_athlete ON maps_workout_geo(athlete_id);

      -- A route = a group of same-sport workouts that follow the same course. Stats (count, best time …) are computed
      -- when reading so hiding a workout needs no rebuild. custom_name is the only user data in here.
      CREATE TABLE maps_routes (
        id INTEGER PRIMARY KEY,
        athlete_id INTEGER NOT NULL,
        sport TEXT NOT NULL,
        rep_workout_id INTEGER,          -- representative = earliest member
        kind TEXT NOT NULL DEFAULT 'loop',   -- loop | out_and_back | point_to_point
        area TEXT,                       -- city of the representative's time zone, if known
        distance_m REAL NOT NULL DEFAULT 0,  -- median length of the members
        start_lat REAL, start_lon REAL, end_lat REAL, end_lon REAL,
        polyline TEXT,
        custom_name TEXT
      );
      CREATE INDEX ix_maps_routes_athlete ON maps_routes(athlete_id, sport);
    `,
  },
  {
    id: 'maps_003_segments',
    up: /* sql */ `
      -- User-defined segments (a stretch of a workout's route). The rows are user data; the efforts are derived.
      CREATE TABLE maps_segments (
        id INTEGER PRIMARY KEY,
        athlete_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        sport TEXT NOT NULL,             -- sport of the source workout; its compatible sports are matched
        source_workout_id INTEGER,
        distance_m REAL NOT NULL,
        elevation_gain_m REAL,
        elevation_loss_m REAL,
        avg_grade REAL,                  -- percent
        start_lat REAL NOT NULL, start_lon REAL NOT NULL, end_lat REAL NOT NULL, end_lon REAL NOT NULL,
        min_lat REAL NOT NULL, min_lon REAL NOT NULL, max_lat REAL NOT NULL, max_lon REAL NOT NULL,
        polyline TEXT NOT NULL,          -- simplified (5 m), for display
        path BLOB NOT NULL,              -- gzip(JSON {lat, lon, dist, ele}) thinned to ~1.5 m: matching + profile
        starred INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX ix_maps_segments_athlete ON maps_segments(athlete_id);

      -- One row per pass of a workout through a segment (a workout can pass several times, e.g. laps).
      CREATE TABLE maps_segment_efforts (
        segment_id INTEGER NOT NULL REFERENCES maps_segments(id) ON DELETE CASCADE,
        workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        athlete_id INTEGER NOT NULL,
        start_ts REAL NOT NULL,          -- interpolated crossing of the start gate (unix seconds)
        elapsed_s REAL NOT NULL,
        moving_s REAL,
        avg_hr REAL,
        avg_speed REAL NOT NULL,         -- segment length / elapsed
        track_m REAL,                    -- distance the track covered between the gates
        PRIMARY KEY (segment_id, workout_id, idx)
      ) WITHOUT ROWID;
      CREATE INDEX ix_maps_segment_efforts_workout ON maps_segment_efforts(workout_id);
    `,
  },
];
