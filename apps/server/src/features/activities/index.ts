import type { Feature } from '../types';
import routes from './routes';
import { deriveAnalyses } from './store';

/**
 * "activities" feature module (server side): dashboard summary, activity feed/list with medals and totals,
 * previous/next navigation, per-activity analysis (cached in activities_analysis) and similar activities.
 */
const feature: Feature = {
  name: 'activities',
  migrations: [
    {
      id: 'activities_001_analysis',
      up: /* sql */ `
        -- Per workout analysis computed from the streams (see features/activities/analysis.ts).
        -- cache_key = analysis version | derived_version | workouts.updated_at | stream version:points
        CREATE TABLE activities_analysis (
          workout_id INTEGER PRIMARY KEY REFERENCES workouts(id) ON DELETE CASCADE,
          athlete_id INTEGER NOT NULL,
          cache_key TEXT NOT NULL,
          efficiency REAL,               -- efficiency factor (m/min per bpm, or W per bpm)
          decoupling_pct REAL,           -- aerobic decoupling in %
          gap_speed REAL,                -- grade adjusted speed (m/s)
          avg_speed REAL,                -- moving average speed from the streams (m/s)
          np_w REAL,                     -- normalized power (W)
          climb_count INTEGER NOT NULL DEFAULT 0,
          climb_gain_m REAL NOT NULL DEFAULT 0,
          data BLOB NOT NULL,            -- gzip(JSON ActivityAnalysis)
          computed_at INTEGER NOT NULL
        );
        CREATE INDEX ix_activities_analysis_athlete ON activities_analysis(athlete_id);
      `,
    },
  ],
  deriveSteps: [
    {
      id: 'activities.analysis',
      label: 'Activity analysis (climbs, decoupling, efficiency)',
      weight: 1,
      run: deriveAnalyses,
    },
  ],
  routes,
};

export default feature;
