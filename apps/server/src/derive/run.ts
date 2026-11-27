import { all, type Db } from '../db/db';
import { features } from '../features';
import type { DeriveChanges, DeriveContext, DeriveStep } from '../features/types';
import { CancelledError, DERIVE_VERSION, type CoreDeriveContext } from './context';
import { coreDeriveSteps } from './pipeline';

export interface RunDeriveOptions {
  db: Db;
  athleteId: number;
  /**
   * Workouts inserted/changed, or 'all' for a full rebuild. Workouts derived by an older DERIVE_VERSION are added;
   * ids that are no workout of the athlete are dropped.
   */
  workoutIds: number[] | 'all';
  /** Earliest local day touched by new records, null = recompute every day. */
  sinceDay: string | null;
  /** Per record type: earliest start_ts of new records (more precise than sinceDay for daily metrics). */
  typeSince?: Map<number, number> | null;
  /** Progress 0..1 with the current step (its id and English label). */
  onProgress?: (fraction: number, step: Pick<DeriveStep, 'id' | 'label'>, message?: string) => void;
  checkCancelled?: () => void;
  log?: (message: string) => void;
  /** Run feature derive steps after the core steps (default true). */
  includeFeatures?: boolean;
}

export interface DeriveResult {
  /** Workouts derived by this run (the given ones plus those of an older DERIVE_VERSION), or 'all'. */
  workoutIds: number[] | 'all';
  /** What changed besides the workouts (see DeriveContext.changes). */
  changes: DeriveChanges;
  warnings: string[];
  steps: { id: string; ms: number; error?: string }[];
}

/** typeSince by identifier (DeriveChanges.recordTypes). */
function recordTypesOf(db: Db, typeSince: Map<number, number> | null | undefined): DeriveChanges['recordTypes'] {
  if (!typeSince) return 'all';
  const out = new Map<string, number>();
  if (!typeSince.size) return out;
  const names = new Map(
    all<{ id: number; identifier: string }>(db, 'SELECT id, identifier FROM record_types').map((r) => [
      r.id,
      r.identifier,
    ]),
  );
  for (const [id, ts] of typeSince) {
    const name = names.get(id);
    if (name !== undefined) out.set(name, ts);
  }
  return out;
}

/**
 * Runs the core derive steps and then every feature's deriveSteps (registration order) with a shared
 * DeriveContext; overall progress is weighted by each step's `weight`. A failing feature step is logged as a
 * warning and does not fail the import; a failing core step does.
 */
export async function runDerive(o: RunDeriveOptions): Promise<DeriveResult> {
  let workoutIds = o.workoutIds;
  if (workoutIds !== 'all') {
    // the athlete's own workouts only: feature steps never get another athlete's ids or those of deleted workouts
    if (workoutIds.length)
      workoutIds = all<{ id: number }>(
        o.db,
        'SELECT id FROM workouts WHERE athlete_id = ? AND id IN (SELECT value FROM json_each(?))',
        [o.athleteId, JSON.stringify(workoutIds)],
      ).map((r) => r.id);
    const outdated = all<{ id: number }>(
      o.db,
      'SELECT id FROM workouts WHERE athlete_id = ? AND derived_version < ?',
      [o.athleteId, DERIVE_VERSION],
    ).map((r) => r.id);
    workoutIds = [...new Set([...workoutIds, ...outdated])].sort((a, b) => a - b);
  }
  const featureSteps = o.includeFeatures === false ? [] : features.flatMap((f) => f.deriveSteps ?? []);
  const steps: { step: DeriveStep; core: boolean }[] = [
    ...coreDeriveSteps.map((step) => ({ step, core: true })),
    ...featureSteps.map((step) => ({ step, core: false })),
  ];
  const total = steps.reduce((s, x) => s + (x.step.weight ?? 1), 0) || 1;
  const warnings: string[] = [];
  const timings: DeriveResult['steps'] = [];
  let done = 0;
  const check = o.checkCancelled ?? (() => {});
  const ctx: CoreDeriveContext = {
    db: o.db,
    athleteId: o.athleteId,
    workoutIds,
    sinceDay: o.sinceDay,
    report: () => {},
    checkCancelled: check,
    log: o.log ?? (() => {}),
    core: { typeSince: o.typeSince ?? null, warnings },
    changes: {
      recordTypes: recordTypesOf(o.db, o.typeSince),
      effortBasis: false,
      duplicateFlips: [],
    },
  };
  for (const { step, core } of steps) {
    check();
    const w = step.weight ?? 1;
    const base = done;
    ctx.report = (fraction: number, message?: string) =>
      o.onProgress?.(
        Math.min(1, (base + Math.max(0, Math.min(1, fraction)) * w) / total),
        step,
        message,
      );
    ctx.report(0);
    const t0 = performance.now();
    try {
      await step.run(ctx as DeriveContext);
      timings.push({ id: step.id, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      if (e instanceof CancelledError || core) throw e;
      const msg = `Derive step ${step.id} failed: ${(e as Error).message}`;
      warnings.push(msg);
      ctx.log(msg);
      timings.push({ id: step.id, ms: Math.round(performance.now() - t0), error: (e as Error).message });
      // a failed step must not leave a transaction open for the next one
      if (o.db.isTransaction) o.db.exec('ROLLBACK');
    }
    done += w;
    o.onProgress?.(done / total, step);
  }
  return { workoutIds: ctx.workoutIds, changes: ctx.changes, warnings, steps: timings };
}
