import type { ImportJob } from '@cadence/shared';
import type { TFunction } from '@/lib/i18n';

/** Pure logic of the import job list: which job is current, what finished, how to poll, translated labels. */

export const isActive = (j: ImportJob) => j.status === 'queued' || j.status === 'running';

/**
 * The job the server works on, else the next one in line. The list is newest first and the server runs queued jobs
 * oldest first, so the next one is the last queued job of the list (not the first active one).
 */
export function currentJob(jobs: ImportJob[]): ImportJob | null {
  return jobs.find((j) => j.status === 'running') ?? jobs.filter((j) => j.status === 'queued').at(-1) ?? null;
}

/** Jobs waiting behind the current one. */
export const waitingJobs = (jobs: ImportJob[]): number =>
  Math.max(0, jobs.filter(isActive).length - 1);

/**
 * Jobs that finished since the previous list: active before, or new and already over (a COROS batch or a derive
 * after a settings change can start and finish between two polls). Nothing on the first load, so the history of
 * finished jobs does not count.
 */
export function finishedSince(prev: ImportJob[] | undefined, next: ImportJob[]): ImportJob[] {
  if (!prev) return [];
  const before = new Map(prev.map((j) => [j.id, j]));
  return next.filter((j) => {
    if (isActive(j)) return false;
    const old = before.get(j.id);
    return old ? isActive(old) : true;
  });
}

export interface JobsIo {
  /** GET /api/import/jobs (newest first). */
  list: (limit?: number) => Promise<ImportJob[]>;
  /** GET /api/import/jobs/:id */
  get: (id: string) => Promise<ImportJob>;
}

/**
 * Whether a poll loads the whole list: when the list was invalidated (a job was just started, settings changed …)
 * and, while a job runs (then only that job is polled), at least every `everyMs` for jobs queued meanwhile. While
 * nothing runs the newest job tells whether anything changed.
 */
export function wantsFullList(
  prev: ImportJob[] | undefined,
  invalidated: boolean,
  msSinceFull: number,
  everyMs: number,
): boolean {
  return invalidated || (!!prev?.some(isActive) && msSinceFull > everyMs);
}

const sameState = (a: ImportJob | undefined, b: ImportJob | undefined) =>
  a?.id === b?.id && a?.status === b?.status && a?.finishedAt === b?.finishedAt;

/**
 * Loads the job list with as little as needed: while a job runs only that job (its progress), while nothing runs
 * only the newest job to see whether anything new arrived; the whole list when something changed or `full` is set.
 * `full` in the result tells whether the whole list was loaded.
 */
export async function loadJobs(
  prev: ImportJob[] | undefined,
  io: JobsIo,
  full: boolean,
): Promise<{ jobs: ImportJob[]; full: boolean }> {
  if (prev && !full) {
    const running = prev.find((j) => j.status === 'running');
    if (running) {
      const job = await io.get(running.id).catch(() => null);
      if (job?.status === 'running') return { jobs: prev.map((j) => (j.id === job.id ? job : j)), full: false };
    } else if (!prev.some(isActive)) {
      const newest = await io.list(1).catch(() => null);
      if (newest && sameState(newest[0], prev[0])) return { jobs: prev, full: false };
    }
  }
  return { jobs: await io.list(), full: true };
}

// ---- labels ------------------------------------------------------------------------------------------------------
// The server describes progress in English (job.message, and job.step = the label of the running derive step). The
// interface shows translated labels derived from the structured fields instead: status, phase and the derive step.

/** Derive steps by id and by the label the server reports in job.step → key in platform.import.steps. */
const STEP_KEYS: Record<string, string> = {
  'core.workouts': 'workouts',
  'Workout streams, splits & best efforts': 'workouts',
  'core.duplicates': 'duplicates',
  'Duplicate detection': 'duplicates',
  'core.daily-metrics': 'dailyMetrics',
  'Daily health metrics': 'dailyMetrics',
  'core.effort': 'effort',
  'Heart rate zones & relative effort': 'effort',
  'core.daily-activity': 'dailyActivity',
  'Daily activity totals': 'dailyActivity',
  'activities.analysis': 'activityAnalysis',
  'Activity analysis (climbs, decoupling, efficiency)': 'activityAnalysis',
  'progress.workout-metrics': 'paceAtHr',
  'Progress: pace at heart rate & running dynamics': 'paceAtHr',
  'progress.power-curve': 'powerCurve',
  'Progress: power curve': 'powerCurve',
  // both progress caches in one step
  'progress.workout-caches': 'paceAndPower',
  'Progress: pace at heart rate, running dynamics & power curve': 'paceAndPower',
  'connect.coros': 'corosDaily',
  'COROS daily data': 'corosDaily',
  'consistency.achievements': 'trophies',
  'Trophies & challenges': 'trophies',
  'maps.geometry': 'mapGeometry',
  'Map tiles and route shapes': 'mapGeometry',
  'maps.segments': 'segments',
  'Segment efforts': 'segments',
  'maps.routes': 'routes',
  'Repeated routes': 'routes',
  'health.sleep': 'sleep',
  'Sleep nights': 'sleep',
  'health.ecg': 'ecg',
  'ECG analysis': 'ecg',
  'health.record-sources': 'recordSources',
  'Sources of health records': 'recordSources',
};

/** Key of a derive step (id or reported label) in platform.import.steps, null when unknown. */
export const stepKey = (step: string | null | undefined): string | null => (step ? (STEP_KEYS[step] ?? null) : null);

/** What the job does right now, e.g. "Analysing workouts". */
export function jobPhaseLabel(t: TFunction, job: ImportJob): string {
  if (job.status === 'queued') return t('platform.import.status.queued');
  return job.phase ? t(`platform.import.phases.${job.phase}`) : t(`platform.import.status.${job.status}`);
}

/** The running derive step, translated; a step this version does not know is only shown in English. */
export function jobStepLabel(t: TFunction, lang: string, job: ImportJob): string | null {
  if (job.status !== 'running' || job.phase !== 'derive' || !job.step) return null;
  const key = stepKey(job.step);
  if (key) return t(`platform.import.steps.${key}`);
  return lang === 'en' ? job.step : null;
}

/** A failed job's error in the language of the interface where the server's wording is known, else as it is. */
export function jobErrorText(t: TFunction, error: string): string {
  // import/jobs.ts: a restart interrupted the job, an upload vanished, the worker thread died
  if (/^Interrupted\b/.test(error)) return t('platform.import.errors.interrupted');
  if (error === 'Source file is gone') return t('platform.import.errors.sourceGone');
  if (/^(Import worker (crashed|exited)|Could not start the import worker)/.test(error)) return t('platform.import.errors.crashed');
  return error;
}

/** Source column of the history: the file name, or what a sync or rebuild brought. */
export function jobSourceLabel(t: TFunction, job: ImportJob): string {
  if (job.kind === 'rederive') return t('platform.import.rederive');
  // COROS names its batches "COROS (3 activities)" (features/connect/coros-sync.ts)
  const coros = /^COROS \((\d+) activit(?:y|ies)\)$/.exec(job.sourceName ?? '');
  if (coros) return t('platform.import.corosBatch', { count: Number(coros[1]) });
  return job.sourceName ?? '–';
}

/**
 * The error to show after uploading `total` files, null when none failed: for a single file what the server said, for
 * several which of them failed (and why, when only one did).
 */
export function uploadFailure(t: TFunction, total: number, failed: { name: string; error: unknown }[]): unknown {
  if (!failed.length) return null;
  if (total === 1) return failed[0]!.error;
  const which = t('platform.import.uploadsFailed', { count: failed.length, names: failed.map((f) => f.name).join(', ') });
  const why = failed.length === 1 && failed[0]!.error instanceof Error ? ` ${failed[0]!.error.message}` : '';
  return new Error(which + why);
}

/**
 * Files to upload one after the other. Files added while a series runs (dropped during an upload) join that series
 * instead of being ignored.
 */
export function uploadQueue<T>() {
  const waiting: T[] = [];
  let running = false;
  return {
    /** Adds files; true when no series runs, so the caller starts one and takes the files with `next`. */
    add(files: T[]): boolean {
      waiting.push(...files);
      if (running || !waiting.length) return false;
      running = true;
      return true;
    },
    /** The next file of the series; undefined ends it. */
    next(): T | undefined {
      const file = waiting.shift();
      if (file === undefined) running = false;
      return file;
    },
    /** Files still waiting in the series. */
    get waiting(): number {
      return waiting.length;
    },
  };
}
