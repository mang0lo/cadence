import { useQuery, type QueryFunctionContext } from '@tanstack/react-query';
import type { ImportJob } from '@cadence/shared';
import { api } from '@/lib/api';
import { currentJob, finishedSince, isActive, loadJobs, waitingJobs, wantsFullList, type JobsIo } from './importJobs';

export { isActive } from './importJobs';

export const IMPORT_JOBS_KEY = ['core', 'import-jobs'] as const;

/** Poll interval while a job is queued or running, and while nothing runs (jobs the server starts by itself). */
const ACTIVE_POLL_MS = 1500;
const IDLE_POLL_MS = 15_000;
/** While a job runs only that job is polled; the whole list (e.g. jobs queued meanwhile) at least this often. */
const FULL_LIST_MS = 15_000;

const io: JobsIo = {
  list: (limit) => api.get<ImportJob[]>('/import/jobs', limit ? { limit } : undefined),
  get: (id) => api.get<ImportJob>(`/import/jobs/${encodeURIComponent(id)}`),
};
let lastFullList = 0;

/**
 * Runs once per fetch, however many components show the jobs: when a job finished since the last fetch, every other
 * query is invalidated, so all pages show the new data.
 */
async function fetchJobs({ client, queryKey }: QueryFunctionContext): Promise<ImportJob[]> {
  const query = client.getQueryCache().find({ queryKey, exact: true });
  const prev = client.getQueryData<ImportJob[]>(queryKey);
  const full = wantsFullList(prev, !!query?.state.isInvalidated, Date.now() - lastFullList, FULL_LIST_MS);
  const res = await loadJobs(prev, io, full);
  if (res.full) lastFullList = Date.now();
  if (finishedSince(prev, res.jobs).length) {
    void client.invalidateQueries({ predicate: (q) => q.queryKey[1] !== 'import-jobs' });
  }
  return res.jobs;
}

/**
 * Import and rebuild jobs (newest first), polled every 1.5 s while one is queued or running and every 15 s (and on
 * window focus) otherwise, so jobs the server starts by itself (COROS sync, watch folder, settings changes) show up
 * too. `current` is the job the server works on, `waiting` how many are queued behind it. Side-effect free: the
 * reaction to a finished job happens in the query function, once per fetch.
 */
export function useImportJobs() {
  const q = useQuery({
    queryKey: IMPORT_JOBS_KEY,
    queryFn: fetchJobs,
    refetchInterval: (query) => ((query.state.data ?? []).some(isActive) ? ACTIVE_POLL_MS : IDLE_POLL_MS),
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });
  const jobs = q.data ?? [];
  return {
    jobs,
    current: currentJob(jobs),
    waiting: waitingJobs(jobs),
    error: q.error,
  };
}
