import type { FastifyPluginAsync } from 'fastify';
import type { ImportHighlight } from '@cadence/shared';
import type { Db } from '../db/db';
import type { Migration } from '../db/migrate';

/** Passed to every derive step after an import (or a manual "rebuild derived data"). */
export interface DeriveContext {
  db: Db;
  athleteId: number;
  /** Workouts inserted or changed by this run, or 'all' for a full rebuild. */
  workoutIds: number[] | 'all';
  /** Earliest local day ('YYYY-MM-DD') touched by new health records, or null = recompute everything. */
  sinceDay: string | null;
  /** Report progress of this step (0..1) with an optional message for the import screen. */
  report: (fraction: number, message?: string) => void;
  /** Throws when the job was cancelled. Call it regularly inside long loops. */
  checkCancelled: () => void;
  log: (message: string) => void;
}

export interface DeriveStep {
  /** Unique id, e.g. 'maps.explorer-tiles'. */
  id: string;
  /** Short label shown on the import screen. */
  label: string;
  /** Relative duration estimate used to weight overall progress (default 1). */
  weight?: number;
  run: (ctx: DeriveContext) => void | Promise<void>;
}

/**
 * A feature module. Registered in features/index.ts; routes are mounted under /api/<name>.
 * Derive steps run in the import worker thread after the core derive steps, in registration order.
 */
export interface Feature {
  name: string;
  migrations?: Migration[];
  routes?: FastifyPluginAsync;
  deriveSteps?: DeriveStep[];
  /**
   * Tables holding data the user wrote (goals, segments, names …) that must survive "delete all data"
   * (POST /api/import/reset). Every other table with an `athlete_id` column is emptied by a reset.
   */
  keepOnReset?: string[];
  /**
   * Runs inside the reset transaction after the data is deleted, e.g. to clear references from kept rows to
   * deleted workouts (workout ids are reused by the next import).
   */
  onReset?: (db: Db, athleteId: number) => void;
  /**
   * "What's new" after an import (shown on the import screen): highlights of the new workouts, e.g. records or
   * trophies. Runs in the import worker after all derive steps; must be fast and must not write.
   */
  whatsNew?: (input: WhatsNewInput) => ImportHighlight[];
}

export interface WhatsNewInput {
  db: Db;
  athleteId: number;
  /** New visible workouts of this import (not hidden, no duplicates), oldest first. */
  workoutIds: number[];
  /** Unix seconds before the derive started: rows a derive step created for this import are newer. */
  since: number;
  /** First import: everything is new, so "new" records, tiles … would only repeat the totals. */
  initial: boolean;
}
