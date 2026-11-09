import { computePlaces } from '../core/workouts';
import { placesAlong, placesColumn } from '../lib/places';
import type { Migration } from './migrate';

/**
 * Core schema. Every table is scoped by athlete_id so a later multi-user server deployment
 * needs no data migration; the desktop app always uses athlete 1.
 *
 * Units are canonical (m, s, m/s, kcal, °C, kg, bpm). Timestamps are unix seconds UTC and
 * `tz_min` holds the local UTC offset in minutes at that moment. `day` columns are local dates.
 *
 * Feature modules add their own tables through their own migrations (see features/types.ts).
 */
export const coreMigrations: Migration[] = [
  {
    id: 'core_001_init',
    up: /* sql */ `
      CREATE TABLE athletes (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'Athlete',
        birth_date TEXT,
        sex TEXT,
        blood_type TEXT,
        skin_type TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      INSERT INTO athletes (id, name) VALUES (1, 'Athlete');

      -- key/value JSON settings (AthleteSettings fields + feature specific keys like 'consistency.goals')
      CREATE TABLE settings (
        athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (athlete_id, key)
      ) WITHOUT ROWID;

      CREATE TABLE sources (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      );

      -- raw = HKDevice description with the per-object pointer stripped ('<<HKDevice>, name:Apple Watch, …>')
      CREATE TABLE devices (
        id INTEGER PRIMARY KEY,
        raw TEXT NOT NULL UNIQUE,
        name TEXT, manufacturer TEXT, model TEXT, hardware TEXT, software TEXT
      );

      -- Dictionary of record types (shared by all athletes; per-athlete stats live in record_type_stats).
      CREATE TABLE record_types (
        id INTEGER PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,              -- 'quantity' | 'category' | 'other'
        unit TEXT,                       -- canonical unit of records.value
        aggregation TEXT NOT NULL DEFAULT 'avg' -- 'sum' (cumulative) | 'avg' (discrete) | 'duration' (category)
      );

      -- Per athlete and record type: number of records and time range (fast data explorer). Maintained by derive.
      CREATE TABLE record_type_stats (
        athlete_id INTEGER NOT NULL,
        type_id INTEGER NOT NULL,
        count INTEGER NOT NULL,
        first_ts INTEGER,
        last_ts INTEGER,
        PRIMARY KEY (athlete_id, type_id)
      ) WITHOUT ROWID;

      -- Every <Record> of the export. Clustered by (type, start) which is how it is queried.
      -- hash = 32-bit hash of (end_ts, source, value, text) → re-importing a newer export dedupes.
      CREATE TABLE records (
        athlete_id INTEGER NOT NULL,
        type_id INTEGER NOT NULL,
        start_ts INTEGER NOT NULL,
        hash INTEGER NOT NULL,
        end_ts INTEGER NOT NULL,
        tz_min INTEGER NOT NULL DEFAULT 0,
        value REAL,                      -- quantity value in canonical unit
        text TEXT,                       -- category value, e.g. 'AsleepDeep' (prefix HKCategoryValue… stripped)
        source_id INTEGER NOT NULL DEFAULT 0,
        device_id INTEGER,
        created_ts INTEGER,
        meta TEXT,                       -- JSON object of MetadataEntry (+ HRV beat list), only if present
        PRIMARY KEY (athlete_id, type_id, start_ts, hash)
      ) WITHOUT ROWID;

      -- <Correlation> (blood pressure, food). Child records are also stored in records.
      CREATE TABLE correlations (
        id INTEGER PRIMARY KEY,
        athlete_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        start_ts INTEGER NOT NULL,
        end_ts INTEGER NOT NULL,
        tz_min INTEGER NOT NULL DEFAULT 0,
        source_id INTEGER NOT NULL DEFAULT 0,
        meta TEXT,
        items TEXT NOT NULL,             -- JSON [{type, value, unit, text}]
        UNIQUE (athlete_id, type, start_ts, end_ts, source_id)
      );

      -- <ActivitySummary> = Apple activity rings per day
      CREATE TABLE activity_summaries (
        athlete_id INTEGER NOT NULL,
        day TEXT NOT NULL,
        active_energy_kcal REAL,
        active_energy_goal_kcal REAL,
        move_time_min REAL,
        move_time_goal_min REAL,
        exercise_min REAL,
        exercise_goal_min REAL,
        stand_hours REAL,
        stand_goal_hours REAL,
        PRIMARY KEY (athlete_id, day)
      ) WITHOUT ROWID;

      CREATE TABLE workouts (
        id INTEGER PRIMARY KEY,
        athlete_id INTEGER NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
        ext_key TEXT NOT NULL,           -- dedupe key: activityType|start|end|source
        activity_type TEXT NOT NULL,     -- raw HKWorkoutActivityType…
        sport TEXT NOT NULL,             -- effective sport key (user override wins, see sport_locked)
        name TEXT NOT NULL DEFAULT '',   -- effective name (auto "Morning Run" unless name_locked)
        notes TEXT,
        name_locked INTEGER NOT NULL DEFAULT 0,
        sport_locked INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        duplicate_of INTEGER,            -- set when another workout covers the same session
        start_ts INTEGER NOT NULL,
        end_ts INTEGER NOT NULL,
        tz_min INTEGER NOT NULL DEFAULT 0,
        timezone TEXT,                   -- IANA zone from HKTimeZone metadata when present
        duration_s REAL NOT NULL,
        moving_s REAL,
        distance_m REAL,
        energy_kcal REAL,
        elevation_gain_m REAL,
        elevation_loss_m REAL,
        avg_hr REAL, min_hr REAL, max_hr REAL,
        avg_speed REAL, max_speed REAL,
        avg_cadence REAL, avg_power REAL, max_power REAL,
        step_count REAL, swim_strokes REAL, lap_length_m REAL,
        indoor INTEGER NOT NULL DEFAULT 0,
        temperature_c REAL, humidity_pct REAL,
        source_name TEXT, source_version TEXT, device TEXT,
        meta TEXT,                       -- JSON object of all MetadataEntry
        stats TEXT,                      -- JSON WorkoutStatistic[]
        has_route INTEGER NOT NULL DEFAULT 0,
        start_lat REAL, start_lon REAL, end_lat REAL, end_lon REAL,
        min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL,
        polyline TEXT,                   -- encoded polyline (precision 5) of the simplified route
        trimp REAL,
        effort REAL,                     -- relative effort / training load
        effort_estimated INTEGER NOT NULL DEFAULT 0,
        hr_zones TEXT,                   -- JSON [s_z1..s_z5]
        hr_hist BLOB,                    -- gzip(Float32Array[256]): seconds spent at each bpm (zones/TRIMP for any settings)
        derived_version INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE (athlete_id, ext_key)
      );
      CREATE INDEX ix_workouts_start ON workouts(athlete_id, start_ts);
      CREATE INDEX ix_workouts_sport ON workouts(athlete_id, sport, start_ts);

      -- iOS 16+ <WorkoutActivity> children (multisport / intervals)
      CREATE TABLE workout_activities (
        workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        activity_type TEXT NOT NULL,
        sport TEXT NOT NULL,
        start_ts INTEGER NOT NULL,
        end_ts INTEGER NOT NULL,
        duration_s REAL,
        stats TEXT,
        meta TEXT,
        PRIMARY KEY (workout_id, idx)
      ) WITHOUT ROWID;

      CREATE TABLE workout_events (
        workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        type TEXT NOT NULL,              -- pause | resume | lap | marker | segment | motion_paused | motion_resumed | pause_or_resume_request
        ts REAL NOT NULL,
        duration_s REAL,
        meta TEXT,
        PRIMARY KEY (workout_id, idx)
      ) WITHOUT ROWID;

      CREATE TABLE workout_routes (
        workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
        file TEXT NOT NULL,              -- path inside the export, e.g. workout-routes/route_2024-05-01_7.30am.gpx
        point_count INTEGER,
        start_ts INTEGER,
        end_ts INTEGER,
        linked_by TEXT,                  -- 'reference' (FileReference) | 'overlap' (matched by time) | 'inline'
        data BLOB,                       -- gzip raw track (src/import/track.ts), lets derive re-run without the zip
        PRIMARY KEY (workout_id, file)
      ) WITHOUT ROWID;
      CREATE INDEX ix_workout_routes_file ON workout_routes(file);

      -- gzip(JSON WorkoutStreams): merged GPS + heart rate + cadence + power time series
      CREATE TABLE workout_streams (
        workout_id INTEGER PRIMARY KEY REFERENCES workouts(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        points INTEGER NOT NULL,
        data BLOB NOT NULL
      );

      CREATE TABLE workout_splits (
        workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
        unit TEXT NOT NULL,              -- 'km' | 'mi'
        idx INTEGER NOT NULL,
        distance_m REAL NOT NULL,
        elapsed_s REAL NOT NULL,
        moving_s REAL NOT NULL,
        elev_diff_m REAL,
        avg_hr REAL,
        avg_speed REAL NOT NULL,
        PRIMARY KEY (workout_id, unit, idx)
      ) WITHOUT ROWID;

      -- fastest time for each standard distance inside each workout (see BEST_EFFORTS in @cadence/shared)
      CREATE TABLE best_efforts (
        athlete_id INTEGER NOT NULL,
        workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
        sport TEXT NOT NULL,
        effort TEXT NOT NULL,
        distance_m REAL NOT NULL,
        elapsed_s REAL NOT NULL,
        start_offset_s REAL NOT NULL,
        start_ts INTEGER NOT NULL,       -- workout start, for chronological progressions
        PRIMARY KEY (workout_id, effort)
      ) WITHOUT ROWID;
      CREATE INDEX ix_best_efforts ON best_efforts(athlete_id, sport, effort, elapsed_s);

      -- Daily aggregate of every record type. metric = record type identifier, or
      -- '<category identifier>:<value>' for category types (value = minutes).
      CREATE TABLE daily_metrics (
        athlete_id INTEGER NOT NULL,
        metric TEXT NOT NULL,
        day TEXT NOT NULL,
        value REAL NOT NULL,
        min REAL,
        max REAL,
        n INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (athlete_id, metric, day)
      ) WITHOUT ROWID;

      -- Workout totals per local day and sport (hidden and duplicate workouts excluded)
      CREATE TABLE daily_activity (
        athlete_id INTEGER NOT NULL,
        day TEXT NOT NULL,
        sport TEXT NOT NULL,
        count INTEGER NOT NULL,
        duration_s REAL NOT NULL,
        moving_s REAL NOT NULL,
        distance_m REAL NOT NULL,
        elevation_m REAL NOT NULL,
        energy_kcal REAL NOT NULL,
        effort REAL NOT NULL,
        PRIMARY KEY (athlete_id, day, sport)
      ) WITHOUT ROWID;

      CREATE TABLE ecg_readings (
        id INTEGER PRIMARY KEY,
        athlete_id INTEGER NOT NULL,
        recorded_ts INTEGER NOT NULL,
        tz_min INTEGER NOT NULL DEFAULT 0,
        classification TEXT,
        symptoms TEXT,
        software_version TEXT,
        device TEXT,
        sample_rate_hz REAL,
        lead TEXT,
        unit TEXT,
        samples BLOB,                    -- gzip(Float32Array little endian), unit as in 'unit' (µV)
        file TEXT,
        UNIQUE (athlete_id, recorded_ts)
      );

      -- Everything else in the export (Audiogram, ClinicalRecord, VisionPrescription, unknown elements),
      -- kept verbatim so the import is lossless.
      CREATE TABLE health_items (
        id INTEGER PRIMARY KEY,
        athlete_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        start_ts INTEGER,
        hash INTEGER NOT NULL,
        data TEXT NOT NULL,              -- JSON {attrs, children}
        UNIQUE (athlete_id, kind, hash)
      );

      CREATE TABLE import_jobs (
        id TEXT PRIMARY KEY,
        athlete_id INTEGER NOT NULL,
        kind TEXT NOT NULL,              -- 'import' | 'rederive'
        status TEXT NOT NULL,            -- queued | running | done | failed | cancelled
        phase TEXT,
        progress REAL NOT NULL DEFAULT 0,
        message TEXT,
        source_name TEXT,
        source_path TEXT,
        size_bytes INTEGER,
        stats TEXT,
        options TEXT,                    -- JSON: {deleteAfter, origin, workoutIds, sinceDay}
        error TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX ix_import_jobs_created ON import_jobs(athlete_id, created_at);
    `,
  },
  {
    id: 'core_002_workout_samples',
    up: /* sql */ `
      -- Sensor time series recorded by the device itself (FIT files from COROS, Garmin, …): heart rate, power,
      -- cadence and distance per sample. When present, derive uses them instead of Apple Health records.
      -- data = gzip(JSON SensorSamples, src/import/samples.ts)
      CREATE TABLE workout_samples (
        workout_id INTEGER PRIMARY KEY REFERENCES workouts(id) ON DELETE CASCADE,
        points INTEGER NOT NULL,
        data BLOB NOT NULL
      );
    `,
  },
  {
    // Place names of start and (one-way) end, so the activity list can search them; filled by derive from now on
    id: 'core_003_workout_places',
    up: (db) => {
      db.exec('ALTER TABLE workouts ADD COLUMN place TEXT; ALTER TABLE workouts ADD COLUMN place_end TEXT;');
      const rows = db
        .prepare('SELECT id, start_lat, start_lon, end_lat, end_lon FROM workouts WHERE start_lat IS NOT NULL')
        .all() as { id: number; start_lat: number; start_lon: number; end_lat: number | null; end_lon: number | null }[];
      const upd = db.prepare('UPDATE workouts SET place = ?, place_end = ? WHERE id = ?');
      for (const r of rows) {
        const p = computePlaces(r.start_lat, r.start_lon, r.end_lat, r.end_lon);
        if (p.place) upd.run(p.place, p.placeEnd, r.id);
      }
    },
  },
  {
    // Every place a route passes through ("|Hannover|Berlin|"), for the activity search
    id: 'core_004_workout_places_via',
    up: (db) => {
      db.exec('ALTER TABLE workouts ADD COLUMN places_via TEXT');
      const rows = db.prepare('SELECT id, polyline FROM workouts WHERE polyline IS NOT NULL').all() as {
        id: number;
        polyline: string;
      }[];
      const upd = db.prepare('UPDATE workouts SET places_via = ? WHERE id = ?');
      for (const r of rows) {
        const via = placesColumn(placesAlong(r.polyline));
        if (via) upd.run(via, r.id);
      }
    },
  },
  {
    // Automatic tags: countries of the route ("|DE|AT|") and hard repetitions (training kind); filled by the
    // derive step (DERIVE_VERSION 3 rebuilds existing workouts once)
    id: 'core_005_workout_tags',
    up: 'ALTER TABLE workouts ADD COLUMN countries TEXT; ALTER TABLE workouts ADD COLUMN hard_reps INTEGER;',
  },
];
