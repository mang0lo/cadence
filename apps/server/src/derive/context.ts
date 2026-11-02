import type { DeriveContext } from '../features/types';

/**
 * Bump to make the next import / rederive recompute every workout derived by an older version; the server also
 * queues that rederive by itself when it starts (JobManager.start).
 * 2: track breaks (no distance, elevation or line across a jump while paused), multi-part polylines.
 */
export const DERIVE_VERSION = 2;
/** Version of the gzip JSON stored in workout_streams. */
export const STREAMS_VERSION = 1;

/** Extra state the core steps share (features only see the DeriveContext part). */
export interface CoreDeriveContext extends DeriveContext {
  core: {
    /** typeId → earliest start_ts of newly imported records; null = every type from ctx.sinceDay (or all). */
    typeSince: Map<number, number> | null;
    warnings: string[];
  };
}

export function asCore(ctx: DeriveContext): CoreDeriveContext {
  const c = ctx as CoreDeriveContext;
  c.core ??= { typeSince: null, warnings: [] };
  return c;
}

/** Thrown by checkCancelled(). */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}
