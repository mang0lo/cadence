import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ImportErrorCode, ImportJob, ImportPhase, ImportStats, ImportStatus } from '@cadence/shared';
import type { Config } from '../config';
import { invalidateStatusCounts } from '../core/routes';
import { all, get, json, run, type Db } from '../db/db';
import { CancelledError, DERIVE_VERSION } from '../derive/context';
import { errorCodeOf, executeJob, progressSaver, type JobOptions, type JobSpec } from './run-job';
import { athletesWithPendingChanges, pendingScope } from './scope';
import type { JobWorkerData, WorkerMessage } from './worker';
import { emptyStats } from './writer';

/**
 * True when a failed job did not fail because of its input but because the server or its worker stopped (the error
 * texts start() / close() / the worker handlers below write): trying again can succeed.
 */
export function wasInterrupted(error: string | null | undefined): boolean {
  return !!error && /^(Interrupted|Import worker (crashed|exited unexpectedly)|Could not start the import worker)/.test(error);
}

/** The errors the job manager writes itself (start / close / worker handlers below) with their code. */
const MANAGER_ERRORS: [RegExp, ImportErrorCode][] = [
  [/^Interrupted\b/, 'interrupted'],
  [/^Not resumed\b/, 'not_resumed'],
  [/^Source file is gone$/, 'source_gone'],
  [/^(Import worker (crashed|exited unexpectedly)|Could not start the import worker)/, 'worker_crashed'],
];

/**
 * Code of a failed job's error text: for the errors this file writes, and for jobs that failed before the code was
 * stored (import_jobs.error_code NULL). Any other text is 'failed'.
 */
export function jobErrorCode(error: string | null | undefined): ImportErrorCode | null {
  if (!error) return null;
  return MANAGER_ERRORS.find(([re]) => re.test(error))?.[1] ?? 'failed';
}

/** Options of two derive requests run as one job: 'all' absorbs the other, otherwise their scopes are united. */
export function mergeDeriveOptions(a: JobOptions, b: JobOptions): JobOptions {
  // "Rebuild analysis" ('api') joined by a real change is no longer only a request (run-job.ts hands that one on)
  if (a.origin === 'api' && b.origin !== 'api') return mergeDeriveOptions({ ...a, origin: b.origin }, b);
  const ids = (o: JobOptions) => o.workoutIds ?? 'all';
  const ia = ids(a);
  const ib = ids(b);
  if (ia === 'all' || ib === 'all') return { ...a, workoutIds: 'all', sinceDay: null, records: undefined };
  const records = a.records !== false || b.records !== false;
  const days = [a, b].filter((o) => o.records !== false || o.sinceDay).map((o) => o.sinceDay ?? null);
  // without a day, a request with records means every day (scope.ts); one without records only names workouts
  const sinceDay = days.includes(null) ? null : (days.filter((d): d is string => d !== null).sort()[0] ?? null);
  return {
    ...a,
    workoutIds: [...new Set([...ia, ...ib])].sort((x, y) => x - y),
    sinceDay,
    records: records ? undefined : false,
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Import / derive job queue (one job at a time). */
    jobs: JobManager;
  }
}

interface JobRow {
  id: string;
  athlete_id: number;
  kind: 'import' | 'rederive';
  status: ImportStatus;
  phase: ImportPhase | null;
  progress: number;
  message: string | null;
  source_name: string | null;
  source_path: string | null;
  size_bytes: number | null;
  stats: string | null;
  options: string | null;
  error: string | null;
  error_code: ImportErrorCode | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

interface Running {
  id: string;
  athleteId: number;
  job: ImportJob;
  options: JobOptions;
  sourcePath: string | null;
  startedMs: number;
  cancel: Int32Array;
  worker: Worker | null;
  done: boolean;
}

export type JobRunnerMode = 'worker' | 'inline';

function toJob(r: JobRow): ImportJob {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    phase: r.phase,
    progress: r.progress,
    message: r.message,
    sourceName: r.source_name,
    sizeBytes: r.size_bytes,
    stats: { ...emptyStats(), ...json<Partial<ImportStats>>(r.stats, {}) },
    error: r.error,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    etaS: null,
    step: null,
    stepId: null,
    errorCode: r.status === 'failed' ? (r.error_code ?? jobErrorCode(r.error) ?? 'failed') : null,
  };
}

/** Entry file for worker threads: the same file as the server (src/index.ts in dev, dist/index.js bundled). */
function workerEntry(): URL {
  return import.meta.url.endsWith('.ts') ? new URL('../index.ts', import.meta.url) : new URL(import.meta.url);
}

/**
 * One job at a time; the rest waits in the queue (persisted in import_jobs). Jobs run in a worker thread with
 * its own DB connection so the HTTP server stays responsive ('inline' runs them on the main thread – tests).
 * Live progress is kept in memory; the job's own connection saves it on phase changes / every few seconds
 * (progressSaver), so this thread never waits for the worker's write transactions.
 */
export class JobManager {
  private running: Running | null = null;
  private closed = false;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<(job: ImportJob) => void>();

  constructor(
    private readonly db: Db,
    private readonly config: Pick<Config, 'dbPath' | 'uploadsDir'> &
      Partial<Pick<Config, 'dataDir' | 'allowLocalImport' | 'importWatchDir'>>,
    private readonly mode: JobRunnerMode = 'worker',
  ) {}

  /**
   * Recover after a restart: running jobs died with the old process; queued jobs are resumed; changes that no derive
   * finished (an interrupted, cancelled or failed job, see scope.ts) are derived.
   */
  start(): void {
    run(
      this.db,
      `UPDATE import_jobs SET status = 'failed', error = 'Interrupted: the server stopped while this job was running',
         error_code = 'interrupted', finished_at = unixepoch() WHERE status = 'running'`,
    );
    for (const r of all<JobRow>(
      this.db,
      "SELECT * FROM import_jobs WHERE status = 'queued' AND kind = 'import'",
    )) {
      const error = !this.mayResume(r)
        ? 'Not resumed: local imports are disabled on this server'
        : r.source_path && !fs.existsSync(r.source_path)
          ? 'Source file is gone'
          : null;
      if (error)
        run(
          this.db,
          "UPDATE import_jobs SET status = 'failed', error = ?, error_code = ?, finished_at = unixepoch() WHERE id = ?",
          [error, jobErrorCode(error), r.id],
        );
    }
    this.cleanupUploads();
    // a server runs for months: what a restart left behind is not kept until the next one
    this.cleanupTimer = setInterval(() => this.cleanupUploads(), 3600_000);
    this.cleanupTimer.unref();
    // After an app update that changed the derivation (DERIVE_VERSION), rebuild the analysis in the background
    // so existing data picks up the fixes without the user pressing "Rebuild analysis".
    for (const r of all<{ athlete_id: number }>(
      this.db,
      'SELECT DISTINCT athlete_id FROM workouts WHERE derived_version < ?',
      [DERIVE_VERSION],
    )) {
      if (!this.busy(r.athlete_id)) this.enqueueDerive(r.athlete_id, { origin: 'upgrade' });
    }
    // a queued job takes the pending changes over itself
    for (const athleteId of athletesWithPendingChanges(this.db))
      if (!this.busy(athleteId)) this.enqueueRecovery(athleteId);
    queueMicrotask(() => this.pump());
  }

  /**
   * Whether a queued import may run after a restart. Where local imports are disabled (server mode) only when it
   * reads from a folder the server manages itself: uploads, the watch folder, the connect downloads – a queued job
   * in a restored backup could otherwise import any path the server can read.
   */
  private mayResume(r: JobRow): boolean {
    if (this.config.allowLocalImport !== false) return true;
    const { uploadsDir, importWatchDir, dataDir } = this.config;
    const roots = [uploadsDir, importWatchDir, dataDir ? path.join(dataDir, 'connect') : null];
    const file = r.source_path ? path.resolve(r.source_path) : null;
    return !!file && roots.some((d) => !!d && file.startsWith(path.resolve(d) + path.sep));
  }

  /** Called with every job update (progress, status changes). */
  onUpdate(fn: (job: ImportJob) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  enqueueImport(
    athleteId: number,
    sourcePath: string,
    opts: { sourceName?: string; sizeBytes?: number | null; options?: JobOptions } = {},
  ): ImportJob {
    return this.insert(
      athleteId,
      'import',
      sourcePath,
      opts.sourceName ?? path.basename(sourcePath),
      opts.sizeBytes ?? null,
      opts.options ?? {},
    );
  }

  /**
   * Queue a derive run: workoutIds 'all' (default) rebuilds every derived table. While a derive of the athlete is
   * still waiting in the queue, a new request joins it (rapid settings changes or workout edits run one derive, not
   * one each); a running derive is never changed.
   */
  enqueueDerive(athleteId: number, options: JobOptions = {}): ImportJob {
    const opts: JobOptions = { workoutIds: 'all', sinceDay: null, ...options };
    const waiting = get<JobRow>(
      this.db,
      `SELECT * FROM import_jobs WHERE athlete_id = ? AND kind = 'rederive' AND status = 'queued'
       ORDER BY created_at, rowid LIMIT 1`,
      [athleteId],
    );
    if (waiting) {
      const merged = mergeDeriveOptions(json<JobOptions>(waiting.options, {}), opts);
      run(this.db, "UPDATE import_jobs SET options = ? WHERE id = ? AND status = 'queued'", [
        JSON.stringify(merged),
        waiting.id,
      ]);
      return this.get(athleteId, waiting.id)!;
    }
    return this.insert(athleteId, 'rederive', null, null, null, opts);
  }

  /** Derive what earlier jobs left underived (the athlete's pending changes, scope.ts) and nothing else. */
  private enqueueRecovery(athleteId: number): ImportJob {
    return this.enqueueDerive(athleteId, { origin: 'recover', workoutIds: [], sinceDay: null, records: false });
  }

  private insert(
    athleteId: number,
    kind: 'import' | 'rederive',
    sourcePath: string | null,
    sourceName: string | null,
    size: number | null,
    options: JobOptions,
  ): ImportJob {
    const id = randomUUID();
    run(
      this.db,
      `INSERT INTO import_jobs (id, athlete_id, kind, status, progress, source_name, source_path, size_bytes, options, stats, message)
       VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        athleteId,
        kind,
        sourceName,
        sourcePath,
        size,
        JSON.stringify(options),
        JSON.stringify(emptyStats()),
        'Waiting in queue',
      ],
    );
    queueMicrotask(() => this.pump());
    return this.get(athleteId, id)!;
  }

  list(athleteId: number, limit = 50): ImportJob[] {
    return all<JobRow>(
      this.db,
      'SELECT * FROM import_jobs WHERE athlete_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      [athleteId, limit],
    ).map((r) => this.live(r));
  }

  get(athleteId: number, id: string): ImportJob | null {
    const r = get<JobRow>(this.db, 'SELECT * FROM import_jobs WHERE id = ? AND athlete_id = ?', [
      id,
      athleteId,
    ]);
    return r ? this.live(r) : null;
  }

  /** True while a job of the athlete is queued or running. */
  busy(athleteId: number): boolean {
    return !!get(
      this.db,
      "SELECT 1 FROM import_jobs WHERE athlete_id = ? AND status IN ('queued', 'running') LIMIT 1",
      [athleteId],
    );
  }

  cancel(athleteId: number, id: string): ImportJob | null {
    const job = this.get(athleteId, id);
    if (!job) return null;
    if (job.status === 'queued') {
      run(
        this.db,
        "UPDATE import_jobs SET status = 'cancelled', finished_at = unixepoch(), message = 'Cancelled' WHERE id = ?",
        [id],
      );
      const r = get<JobRow>(this.db, 'SELECT * FROM import_jobs WHERE id = ?', [id]);
      if (r?.source_path) this.maybeDeleteSource(r.source_path, json<JobOptions>(r.options, {}));
    } else if (job.status === 'running' && this.running?.id === id) {
      Atomics.store(this.running.cancel, 0, 1);
      this.running.job.message = 'Cancelling…';
    }
    return this.get(athleteId, id);
  }

  /** Stop the running worker (server shutdown). */
  async close(): Promise<void> {
    this.closed = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    const r = this.running;
    if (r && !r.done) {
      Atomics.store(r.cancel, 0, 1);
      await r.worker?.terminate();
      this.persist(r, 'failed', 'Interrupted: the server stopped', 'interrupted');
    }
  }

  private live(r: JobRow): ImportJob {
    const cur = this.running;
    if (cur && cur.id === r.id && !cur.done) {
      const elapsed = (Date.now() - cur.startedMs) / 1000;
      const p = cur.job.progress;
      return { ...cur.job, etaS: p > 0.02 && p < 1 ? Math.round((elapsed * (1 - p)) / p) : null };
    }
    return toJob(r);
  }

  private emit(job: ImportJob): void {
    for (const fn of this.listeners) {
      try {
        fn(job);
      } catch {
        /* listener errors are not our problem */
      }
    }
  }

  private pump(): void {
    if (this.closed || this.running) return;
    let row: JobRow;
    try {
      const next = get<JobRow>(
        this.db,
        "SELECT * FROM import_jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1",
      );
      if (!next) return;
      run(
        this.db,
        "UPDATE import_jobs SET status = 'running', started_at = unixepoch(), message = 'Starting' WHERE id = ?",
        [next.id],
      );
      row = get<JobRow>(this.db, 'SELECT * FROM import_jobs WHERE id = ?', [next.id])!;
    } catch (e) {
      // e.g. the database stayed busy: try again shortly instead of crashing the server (this runs from a timer)
      console.error('Could not start the next job', e);
      setTimeout(() => this.pump(), 2000).unref();
      return;
    }
    const running: Running = {
      id: row.id,
      athleteId: row.athlete_id,
      job: toJob(row),
      options: json<JobOptions>(row.options, {}),
      sourcePath: row.source_path,
      startedMs: Date.now(),
      cancel: new Int32Array(new SharedArrayBuffer(4)),
      worker: null,
      done: false,
    };
    this.running = running;
    this.emit(running.job);
    const spec: JobSpec = {
      id: row.id,
      kind: row.kind,
      athleteId: row.athlete_id,
      sourcePath: row.source_path,
      options: running.options,
    };
    if (this.mode === 'inline') void this.runInline(running, spec);
    else this.runWorker(running, spec);
  }

  /** In memory only: the job's own connection saves the row (progressSaver). */
  private onProgress(
    r: Running,
    m: {
      phase: string;
      progress: number;
      message: string | null;
      step: string | null;
      stepId?: string | null;
      stats: unknown;
    },
  ): void {
    r.job.phase = m.phase as ImportPhase;
    r.job.progress = Math.max(r.job.progress, Math.min(1, m.progress));
    if (!Atomics.load(r.cancel, 0)) r.job.message = m.message;
    r.job.step = m.step;
    r.job.stepId = m.stepId ?? null;
    r.job.stats = m.stats as ImportStats;
    this.emit(this.live({ id: r.id } as JobRow));
  }

  private runWorker(r: Running, spec: JobSpec): void {
    const data: JobWorkerData = {
      role: 'cadence-job',
      dbPath: this.config.dbPath,
      job: spec,
      cancel: r.cancel.buffer as SharedArrayBuffer,
    };
    let worker: Worker;
    try {
      worker = new Worker(workerEntry(), { workerData: data, execArgv: process.execArgv });
    } catch (e) {
      this.finish(r, 'failed', `Could not start the import worker: ${(e as Error).message}`, 'worker_crashed');
      return;
    }
    r.worker = worker;
    worker.on('message', (m: WorkerMessage) => {
      if (m.type === 'progress') this.onProgress(r, m);
      else if (m.type === 'log') {
        if (process.env.CADENCE_DEBUG) console.log(`[import ${r.id.slice(0, 8)}] ${m.message}`);
      } else if (m.type === 'done') {
        r.job.stats = m.stats as ImportStats;
        this.finish(r, 'done', null);
      } else if (m.type === 'failed') {
        r.job.stats = m.stats as ImportStats;
        if (m.cancelled) this.finish(r, 'cancelled', null);
        else this.finish(r, 'failed', m.error, m.code);
      }
    });
    worker.on('error', (e: Error) => this.finish(r, 'failed', `Import worker crashed: ${e.message}`, 'worker_crashed'));
    worker.on('exit', (code) => {
      if (!r.done) this.finish(r, 'failed', `Import worker exited unexpectedly (code ${code})`, 'worker_crashed');
    });
  }

  private async runInline(r: Running, spec: JobSpec): Promise<void> {
    const stats = emptyStats();
    const save = progressSaver(this.db, r.id);
    try {
      await executeJob(
        this.db,
        spec,
        {
          progress: (p) => {
            this.onProgress(r, p);
            save(p);
          },
          checkCancelled: () => {
            if (Atomics.load(r.cancel, 0)) throw new CancelledError();
          },
          log: () => {},
        },
        stats,
      );
      r.job.stats = stats;
      this.finish(r, 'done', null);
    } catch (e) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      r.job.stats = stats;
      if (e instanceof CancelledError) this.finish(r, 'cancelled', null);
      else this.finish(r, 'failed', (e as Error).message, errorCodeOf(e));
    }
  }

  private persist(r: Running, status: ImportStatus, error: string | null, code: ImportErrorCode | null = null): void {
    run(
      this.db,
      `UPDATE import_jobs SET status = ?, error = ?, error_code = ?, finished_at = unixepoch(), progress = ?, phase = ?,
         message = ?, stats = ?
       WHERE id = ?`,
      [
        status,
        error,
        status === 'failed' ? (code ?? 'failed') : null,
        status === 'done' ? 1 : r.job.progress,
        r.job.phase,
        status === 'done' ? 'Done' : status === 'cancelled' ? 'Cancelled' : 'Failed',
        JSON.stringify(r.job.stats),
        r.id,
      ],
    );
  }

  private finish(r: Running, status: ImportStatus, error: string | null, code: ImportErrorCode | null = null): void {
    if (r.done) return;
    r.done = true;
    try {
      this.persist(r, status, error, code);
    } catch (e) {
      console.error('Could not persist job result', e);
    }
    if (r.sourcePath)
      this.maybeDeleteSource(r.sourcePath, r.options);
    invalidateStatusCounts();
    if (this.running === r) this.running = null;
    // An import that stopped half way (cancelled, failed) committed data the derive has not seen: derive it right
    // away. Never after a derive, so one the user cancelled or that keeps failing is not queued again and again.
    if (r.job.kind === 'import' && status !== 'done' && !this.closed) {
      try {
        if (!this.busy(r.athleteId) && !pendingScope(this.db, r.athleteId).empty) this.enqueueRecovery(r.athleteId);
      } catch (e) {
        console.error('Could not queue the derive of a stopped import', e);
      }
    }
    const final = this.get(r.athleteId, r.id);
    if (final) this.emit(final);
    if (!this.closed) setImmediate(() => this.pump());
  }

  /** Uploaded files are temporary: removed once their import ended, failed ones too (nothing can retry an upload).
   * User files (local/watch imports) are never touched. */
  private maybeDeleteSource(file: string, options: JobOptions): void {
    if (!options.deleteAfter) return;
    const uploads = path.resolve(this.config.uploadsDir);
    if (!path.resolve(file).startsWith(uploads + path.sep)) return;
    fs.rm(file, { force: true }, () => {});
  }

  /** Remove stale uploads (not referenced by a queued job and older than a day), e.g. of jobs a restart interrupted. */
  private cleanupUploads(): void {
    const dir = this.config.uploadsDir;
    let names: string[];
    let keep: Set<string>;
    try {
      names = fs.readdirSync(dir);
      keep = new Set(
        all<{ source_path: string }>(
          this.db,
          "SELECT source_path FROM import_jobs WHERE status IN ('queued', 'running') AND source_path IS NOT NULL",
        ).map((r) => path.resolve(r.source_path)),
      );
    } catch {
      return; // no folder yet, or the database is busy: next time
    }
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const n of names) {
      const f = path.resolve(dir, n);
      if (keep.has(f)) continue;
      try {
        const st = fs.statSync(f);
        if (st.isFile() && st.mtimeMs < cutoff) fs.rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
