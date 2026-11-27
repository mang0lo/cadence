import type { ImportErrorCode, ImportPhase, ImportStats } from '@cadence/shared';
import { get, run, type Db } from '../db/db';
import { runDerive, type DeriveResult } from '../derive/run';
import type { DeriveStep } from '../features/types';
import { openFitSource, runFitImport } from './fit/import';
import { runImport, type RunImportOptions } from './importer';
import { claimScope, releaseClaim, scopeFromOptions, type ChangeScope } from './scope';
import { ImportInputError, SourceGoneError } from './source';
import { importSummary } from './summary';
import { emptyStats } from './writer';

/** Options persisted with a job (import_jobs.options). */
export interface JobOptions {
  /** Delete the source file after a successful import (uploads). */
  deleteAfter?: boolean;
  origin?:
    | 'upload'
    | 'local'
    | 'watch'
    | 'api'
    | 'cli'
    | 'reset'
    | 'settings'
    | 'workout'
    | 'upgrade'
    | 'connect'
    | 'recover';
  /** FIT imports from a folder: only these files (absolute paths), e.g. what a device sync just downloaded. */
  files?: string[];
  /** Rederive scope (default: everything), on top of the athlete's pending changes (scope.ts). */
  workoutIds?: number[] | 'all';
  sinceDay?: string | null;
  /**
   * Rederive of some workouts: also recompute the daily metrics of every record type from sinceDay (the whole
   * history when sinceDay is null). Default true; false when no health record changed (an edited workout).
   */
  records?: boolean;
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
  /** English label of the running derive step. */
  step: string | null;
  /** Id of the running derive step (ImportJob.stepId). */
  stepId?: string | null;
  stats: ImportStats;
}

/** Code of an error a job threw (ImportJob.errorCode): a source that is gone, an unreadable file, or 'failed'. */
export function errorCodeOf(e: unknown): ImportErrorCode {
  if (e instanceof SourceGoneError) return 'source_gone';
  return e instanceof ImportInputError ? 'invalid_input' : 'failed';
}

export interface JobHooks {
  progress: (p: JobProgress) => void;
  checkCancelled: () => void;
  log: (message: string) => void;
}

/**
 * Saves a running job's progress in its import_jobs row on phase changes and at most every `everyMs`. Called on the
 * connection that runs the job (the worker's), so the HTTP thread never waits for the job's write transactions. A
 * failed write is skipped (the next one or the final status catches up); a job that stopped running is not touched.
 */
export function progressSaver(db: Db, jobId: string, everyMs = 5000): (p: JobProgress) => void {
  let phase: ImportPhase | null = null;
  let last = 0;
  let progress = 0;
  return (p) => {
    progress = Math.max(progress, Math.min(1, p.progress));
    const now = Date.now();
    if (p.phase === phase && now - last < everyMs) return;
    phase = p.phase;
    last = now;
    try {
      run(
        db,
        "UPDATE import_jobs SET phase = ?, progress = ?, message = ?, stats = ? WHERE id = ? AND status = 'running'",
        [p.phase, progress, p.message, JSON.stringify(p.stats), jobId],
      );
    } catch {
      /* busy or full: the next save or the job's end writes it */
    }
  };
}

type DeriveStepRef = Pick<DeriveStep, 'id' | 'label'>;

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
  const deriveProgress = (base: number, share: number) => (f: number, step: DeriveStepRef, message?: string) => {
    const now = Date.now();
    if (now - lastDerive < 200 && f < 1) return;
    lastDerive = now;
    hooks.progress({
      phase: 'derive',
      progress: base + share * f,
      message: message ? `${step.label} – ${message}` : step.label,
      step: step.label,
      stepId: step.id,
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
    // rows that derive steps create for this import (e.g. trophies) are stamped after this moment
    const deriveStart = Math.floor(Date.now() / 1000);
    hooks.progress({ phase: 'derive', progress: IMPORT_SHARE, message: 'Deriving', step: null, stats });
    // what the import wrote is pending already (plus anything an earlier job left underived)
    const d = await deriveClaimed(db, spec.athleteId, null, hooks, deriveProgress(IMPORT_SHARE, 1 - IMPORT_SHARE));
    stats.workoutsDerived = derivedCount(db, spec.athleteId, d);
    stats.warnings.push(...d.warnings);
    hooks.checkCancelled();
    stats.summary = importSummary(db, spec.athleteId, res.newWorkoutIds, deriveStart, hooks.log);
  } else {
    enterPhase('derive');
    // "Rebuild analysis" (POST /rederive) is a request, no change of the data: not handed on when it does not finish
    const request = spec.options.origin === 'api';
    const scope = scopeFromOptions(spec.options);
    const d = await deriveClaimed(db, spec.athleteId, scope, hooks, deriveProgress(0, 1), request);
    stats.workoutsDerived = derivedCount(db, spec.athleteId, d);
    stats.warnings.push(...d.warnings);
  }
  enterPhase('finalize');
  hooks.progress({ phase: 'finalize', progress: 1, message: 'Done', step: null, stats });
  enterPhase(null);
  return stats;
}

/**
 * Derive everything the athlete has pending (scope.ts) plus `extra`. The changes stay claimed until the derive
 * succeeded, so a cancelled, failed or interrupted derive hands them on to the next job. `extraIsRequest`: `extra`
 * only asks for work (no data changed): it is derived now but not claimed, so it is not handed on.
 */
async function deriveClaimed(
  db: Db,
  athleteId: number,
  extra: ChangeScope | null,
  hooks: JobHooks,
  onProgress: (fraction: number, step: DeriveStepRef, message?: string) => void,
  extraIsRequest = false,
): Promise<DeriveResult> {
  const scope = claimScope(db, athleteId, extraIsRequest ? undefined : (extra ?? undefined));
  if (extraIsRequest && extra) scope.merge(extra);
  const d = await runDerive({
    db,
    athleteId,
    workoutIds: scope.workoutIds(),
    // nothing day-related changed → let feature steps refresh just the last day
    sinceDay: scope.sinceDay(new Date().toISOString().slice(0, 10), earliestStart(db, athleteId, scope)),
    typeSince: scope.typeSince(),
    checkCancelled: hooks.checkCancelled,
    log: hooks.log,
    onProgress,
  });
  releaseClaim(db, athleteId);
  return d;
}

/** Earliest start of the scope's workouts (those with a new route were noted without their start). */
function earliestStart(db: Db, athleteId: number, scope: ChangeScope): number | null {
  if (scope.all || !scope.workouts.size) return null;
  return (
    get<{ t: number | null }>(
      db,
      'SELECT MIN(start_ts) AS t FROM workouts WHERE athlete_id = ? AND id IN (SELECT value FROM json_each(?))',
      [athleteId, JSON.stringify([...scope.workouts])],
    )?.t ?? null
  );
}

function derivedCount(db: Db, athleteId: number, d: DeriveResult): number {
  if (d.workoutIds !== 'all') return d.workoutIds.length;
  return get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM workouts WHERE athlete_id = ?', [athleteId])!.n;
}
