import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../db/db';
import type { ImportErrorCode } from '@cadence/shared';
import { CancelledError } from '../derive/context';
import { errorCodeOf, executeJob, progressSaver, type JobSpec } from './run-job';
import { emptyStats } from './writer';

/** workerData of an import / derive worker (see jobs.ts). */
export interface JobWorkerData {
  role: 'cadence-job';
  dbPath: string;
  job: JobSpec;
  /** Int32Array(1) flag: set to 1 by the main thread to cancel. */
  cancel: SharedArrayBuffer;
}

export type WorkerMessage =
  | {
      type: 'progress';
      phase: string;
      progress: number;
      message: string | null;
      step: string | null;
      stepId?: string | null;
      stats: unknown;
    }
  | { type: 'log'; message: string }
  | { type: 'done'; stats: unknown }
  | { type: 'failed'; error: string; code: ImportErrorCode; cancelled: boolean; stats: unknown };

/** Entry of the import worker thread (src/index.ts runs this when !isMainThread). */
export async function runWorker(): Promise<void> {
  const data = workerData as JobWorkerData | undefined;
  if (!parentPort || !data || data.role !== 'cadence-job') return;
  const port = parentPort;
  const post = (m: WorkerMessage) => port.postMessage(m);
  const flag = new Int32Array(data.cancel);
  const stats = emptyStats();
  const db = openDb(data.dbPath);
  // the importer benefits from a bigger page cache than the HTTP connection
  db.exec('PRAGMA cache_size = -131072');
  // the job row's progress is saved here, between (or inside) the job's own transactions, not by the HTTP thread
  const save = progressSaver(db, data.job.id);
  try {
    await executeJob(
      db,
      data.job,
      {
        progress: (p) => {
          post({ type: 'progress', ...p, stats: p.stats });
          save(p);
        },
        checkCancelled: () => {
          if (Atomics.load(flag, 0)) throw new CancelledError();
        },
        log: (message) => post({ type: 'log', message }),
      },
      stats,
    );
    post({ type: 'done', stats });
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    post({
      type: 'failed',
      error: e instanceof Error ? e.message : String(e),
      code: errorCodeOf(e),
      cancelled: e instanceof CancelledError,
      stats,
    });
  } finally {
    db.close();
  }
}
