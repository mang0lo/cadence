import type { DeriveChanges, DeriveContext } from '../features/types';

/**
 * Bump to make the next import / rederive recompute every workout derived by an older version; the server also
 * queues that rederive by itself when it starts (JobManager.start).
 * 2: track breaks (no distance, elevation or line across a jump while paused), multi-part polylines.
 * 3: places, countries and hard repetitions of the route (activity tags).
 * 4: duplicates decided per workout (both halves of a split session stay, a hidden workout is never the original),
 *    cadence from steps only with enough coverage, countries along the whole route, no stale first GPS fix as the
 *    start, hard repetitions with standing recoveries.
 */
export const DERIVE_VERSION = 4;
/** Version of the gzip JSON stored in workout_streams. */
export const STREAMS_VERSION = 1;

/** Extra state the core steps share (features only see the DeriveContext part). */
export interface CoreDeriveContext extends DeriveContext {
  core: {
    /** typeId → earliest start_ts of newly imported records; null = every type from ctx.sinceDay (or all). */
    typeSince: Map<number, number> | null;
    warnings: string[];
  };
  changes: DeriveChanges;
}

/** Changes of a context nobody described: any record type may have changed. */
export function unknownChanges(): DeriveChanges {
  return { recordTypes: 'all', effortBasis: false, duplicateFlips: [] };
}

export function asCore(ctx: DeriveContext): CoreDeriveContext {
  const c = ctx as CoreDeriveContext;
  c.core ??= { typeSince: null, warnings: [] };
  c.changes ??= unknownChanges();
  return c;
}

/** Thrown by checkCancelled(). */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}
