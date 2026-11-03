import type { ImportPhase, ImportStats } from '@cadence/shared';
import type { Db } from '../db/db';
import { runDerive } from '../derive/run';
import { openFitSource, runFitImport } from './fit/import';
import { runImport, type RunImportOptions } from './importer';
import { importSummary } from './summary';
import { emptyStats } from './writer';

/** Options persisted with a job (import_jobs.options). */
export interface JobOptions {
  /** Delete the source file after a successful import (uploads). */
  deleteAfter?: boolean;
  origin?:
    'upload' | 'local' | 'watch' | 'api' | 'cli' | 'reset' | 'settings' | 'workout' | 'upgrade' | 'connect';
  /** FIT imports from a folder: only these files (absolute paths), e.g. what a device sync just downloaded. */
  files?: string[];
  /** Rederive scope (default: everything). */
  workoutIds?: number[] | 'all';
  sinceDay?: string | null;
}

export interface JobSpec {
  id: string;
  kind: 'import' | 'rederive';
  athleteId: number;
  sourcePath: string | null;
  options: JobOptions;
}

export interface JobProgress {
  phase: ImportPhase;
  /** 0..1 overall */
  progress: number;
  message: string | null;
  step: string | null;
  stats: ImportStats;
}

export interface JobHooks {
  progress: (p: JobProgress) => void;
  checkCancelled: () => void;
  log: (message: string) => void;
}

/** Share of the overall progress bar taken by the import part of an import job (rest = derive). */
const IMPORT_SHARE = 0.72;

/**
 * Run one job to completion (used by the worker thread, the inline test runner and the CLI).
 * `stats` is filled in place, so callers still see partial numbers when the job fails or is cancelled.
 */
export async function executeJob(
  db: Db,
  spec: JobSpec,
  hooks: JobHooks,
  stats: ImportStats = emptyStats(),
): Promise<ImportStats> {
  const phaseStart = new Map<ImportPhase, number>();
  let currentPhase: ImportPhase | null = null;
  const enterPhase = (p: ImportPhase | null) => {
    if (p === currentPhase) return;
    const now = performance.now();
    if (currentPhase) {
      const sec = (now - phaseStart.get(currentPhase)!) / 1000;
      (stats.phaseSeconds ??= {})[currentPhase] =
        Math.round(((stats.phaseSeconds[currentPhase] ?? 0) + sec) * 10) / 10;
    }
    currentPhase = p;
    if (p) phaseStart.set(p, now);
  };
  let lastDerive = 0;
  const deriveProgress = (base: number, share: number) => (f: number, label: string, message?: string) => {
    const now = Date.now();
    if (now - lastDerive < 200 && f < 1) return;
    lastDerive = now;
    hooks.progress({
      phase: 'derive',
      progress: base + share * f,
      message: message ? `${label} – ${message}` : label,
      step: label,
      stats,
    });
  };

  if (spec.kind === 'import') {
    if (!spec.sourcePath) throw new Error('Import job without a source path');
    // FIT files (COROS, Garmin … or a device sync) or an Apple Health export
    const fit = await openFitSource(spec.sourcePath, spec.options.files);
    const opts: RunImportOptions = {
      db,
      athleteId: spec.athleteId,
      path: spec.sourcePath,
      checkCancelled: hooks.checkCancelled,
      log: hooks.log,
      onProgress: (p) => {
        enterPhase(p.phase);
        Object.assign(stats, p.stats);
        hooks.progress({
          phase: p.phase,
          progress: IMPORT_SHARE * p.fraction,
          message: p.message,
          step: null,
          stats,
        });
      },
    };
    const res = fit ? await runFitImport({ ...opts, source: fit }) : await runImport(opts);
    Object.assign(stats, res.stats);
    enterPhase('derive');
    const ids = res.changedWorkoutIds;
    // rows that derive steps create for this import (e.g. trophies) are stamped after this moment
    const deriveStart = Math.floor(Date.now() / 1000);
    hooks.progress({ phase: 'derive', progress: IMPORT_SHARE, message: 'Deriving', step: null, stats });
    const d = await runDerive({
      db,
      athleteId: spec.athleteId,
      workoutIds: ids,
      // nothing new → let feature steps refresh just the last day
      sinceDay: res.sinceDay ?? new Date().toISOString().slice(0, 10),
      typeSince: res.typeSince,
      checkCancelled: hooks.checkCancelled,
      log: hooks.log,
      onProgress: deriveProgress(IMPORT_SHARE, 1 - IMPORT_SHARE),
    });
    stats.workoutsDerived = d.workoutIds === 'all' ? stats.workoutsSeen : ids.length;
    stats.warnings.push(...d.warnings);
    hooks.checkCancelled();
    stats.summary = importSummary(db, spec.athleteId, res.newWorkoutIds, deriveStart, hooks.log);
  } else {
    enterPhase('derive');
    const scope = spec.options.workoutIds ?? 'all';
    const d = await runDerive({
      db,
      athleteId: spec.athleteId,
      workoutIds: scope,
      sinceDay: spec.options.sinceDay ?? null,
      checkCancelled: hooks.checkCancelled,
      log: hooks.log,
      onProgress: deriveProgress(0, 1),
    });
    stats.workoutsDerived = scope === 'all' ? countWorkouts(db, spec.athleteId) : scope.length;
    stats.warnings.push(...d.warnings);
  }
  enterPhase('finalize');
  hooks.progress({ phase: 'finalize', progress: 1, message: 'Done', step: null, stats });
  enterPhase(null);
  return stats;
}

function countWorkouts(db: Db, athleteId: number): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM workouts WHERE athlete_id = ?').get(athleteId) as { n: number }
  ).n;
}
