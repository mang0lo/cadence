import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ImportJob } from '@cadence/shared';
import { api } from '@/lib/api';

export const isActive = (j: ImportJob) => j.status === 'queued' || j.status === 'running';

/**
 * Import job list, polled every 1.5 s while a job is queued/running. When a job finishes, every
 * other query is invalidated so all pages show the new data.
 */
export function useImportJobs() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['core', 'import-jobs'],
    queryFn: () => api.get<ImportJob[]>('/import/jobs'),
    refetchInterval: (query) => ((query.state.data ?? []).some(isActive) ? 1500 : false),
    staleTime: 5_000,
  });
  const wasActive = useRef<Set<string>>(new Set());
  useEffect(() => {
    const jobs = q.data ?? [];
    const finished = jobs.filter((j) => wasActive.current.has(j.id) && !isActive(j));
    wasActive.current = new Set(jobs.filter(isActive).map((j) => j.id));
    if (finished.length) {
      void qc.invalidateQueries({ predicate: (query) => query.queryKey[1] !== 'import-jobs' });
    }
  }, [q.data, qc]);
  const jobs = q.data ?? [];
  return { ...q, jobs, active: jobs.find(isActive) ?? null };
}
