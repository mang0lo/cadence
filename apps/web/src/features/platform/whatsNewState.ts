import { useEffect, useState } from 'react';
import type { ImportJob, ImportSummary } from '@cadence/shared';
import { storage } from '@/lib/storage';

const SEEN_KEY = 'cadence.whatsNew.seen';
const WHATS_NEW_SEEN_EVENT = 'cadence:whats-new-seen';

/** Id of the import whose summary the user has already seen (per browser). */
export const seenSummaryId = (): string | null => storage.get(SEEN_KEY);

export function markSummarySeen(jobId: string): void {
  if (storage.get(SEEN_KEY) === jobId) return;
  storage.set(SEEN_KEY, jobId);
  window.dispatchEvent(new Event(WHATS_NEW_SEEN_EVENT));
}

/** The newest finished import with a summary (jobs come newest first). */
export function latestSummaryJob(jobs: ImportJob[]): (ImportJob & { stats: { summary: ImportSummary } }) | null {
  const job = jobs.find((j) => j.kind === 'import' && j.status === 'done');
  return job?.stats.summary ? (job as ImportJob & { stats: { summary: ImportSummary } }) : null;
}

/** Personal records (rank 1) and trophies of a summary, for the short sidebar note. */
export function summaryCounts(s: ImportSummary): { records: number; trophies: number } {
  return {
    records: s.highlights.filter((h) => h.kind === 'record' && h.data.rank === 1).length,
    trophies: s.highlights.filter((h) => h.kind === 'trophy').length,
  };
}

/** The id of the seen summary, updated when another component marks one as seen. */
export function useSeenSummaryId(): string | null {
  const [seen, setSeen] = useState(seenSummaryId);
  useEffect(() => {
    const on = () => setSeen(seenSummaryId());
    window.addEventListener(WHATS_NEW_SEEN_EVENT, on);
    return () => window.removeEventListener(WHATS_NEW_SEEN_EVENT, on);
  }, []);
  return seen;
}
