import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CorosLoginRequest, CorosPrefsPatch, CorosStatus } from '@cadence/shared';
import { api, useApi } from '@/lib/api';
import type { TFunction } from '@/lib/i18n';

export const COROS_KEY = ['connect', 'coros'] as const;

export const syncRunning = (s: CorosStatus | undefined) =>
  !!s?.sync && (s.sync.state === 'listing' || s.sync.state === 'downloading' || s.sync.state === 'health');

/**
 * What a COROS sync changed on the server between two reads of its status: `job` — it queued an import of the
 * downloaded activities; `ended` — it finished: 'sources' (last sync, errors) or 'all' when it also stored health
 * values (resting HR, HRV, sleep …) that every page may show.
 */
export function syncChanges(before: CorosStatus, now: CorosStatus): { job: boolean; ended: 'no' | 'sources' | 'all' } {
  const job = !!now.sync?.jobId && now.sync.jobId !== before.sync?.jobId;
  if (!syncRunning(before) || syncRunning(now)) return { job, ended: 'no' };
  const health = !!now.sync && (now.sync.healthDays > 0 || now.sync.sleepNights > 0);
  return { job, ended: health ? 'all' : 'sources' };
}

/** Every query but the COROS status itself. */
const notCoros = (key: readonly unknown[]) => key[0] !== COROS_KEY[0];

/**
 * GET /api/connect/coros, polled while a sync runs. Makes the rest of the app follow the sync: its import job shows
 * up (it is queued only after listing and downloading, long after "Sync now" returned), and when it ends the data
 * sources (sidebar, settings) and — with new health values — every page load again.
 */
export function useCorosStatus() {
  const qc = useQueryClient();
  const q = useApi<CorosStatus>(COROS_KEY, '/connect/coros', undefined, {
    refetchInterval: (query) => (syncRunning(query.state.data) ? 1500 : false),
    staleTime: 5_000,
  });
  const prev = useRef<CorosStatus | undefined>(undefined);
  useEffect(() => {
    const before = prev.current;
    prev.current = q.data;
    if (!before || !q.data) return;
    const c = syncChanges(before, q.data);
    if (c.ended === 'all') void qc.invalidateQueries({ predicate: (x) => notCoros(x.queryKey) });
    else {
      if (c.job || c.ended === 'sources') void qc.invalidateQueries({ queryKey: ['core', 'import-jobs'] });
      if (c.ended === 'sources') void qc.invalidateQueries({ queryKey: ['core', 'sources'] });
    }
  }, [q.data, qc]);
  return q;
}

/**
 * Changes of the COROS connection. Login and disconnect change more than the COROS status: the first login makes
 * COROS the watch in the settings, and both change the data sources and so which source the pages prefer — all of
 * that loads again.
 */
export function useCorosMutations() {
  const qc = useQueryClient();
  return useMemo(() => {
    const setStatus = (s: CorosStatus) => qc.setQueryData([...COROS_KEY, null], s);
    const accountChanged = (s: CorosStatus) => {
      setStatus(s);
      void qc.invalidateQueries({ predicate: (x) => notCoros(x.queryKey) });
    };
    return {
      login: async (body: CorosLoginRequest) => accountChanged(await api.post<CorosStatus>('/connect/coros/login', body)),
      disconnect: async () => accountChanged(await api.delete<CorosStatus>('/connect/coros')),
      /** Starts a sync in the background; the status (polled while it runs) shows its progress. */
      sync: async (full: boolean) => {
        try {
          await api.post('/connect/coros/sync', full ? { full: true } : {});
        } finally {
          await qc.invalidateQueries({ queryKey: COROS_KEY });
        }
      },
      prefs: async (patch: CorosPrefsPatch) => setStatus(await api.patch<CorosStatus>('/connect/coros', patch)),
    };
  }, [qc]);
}

// The server describes sync problems in English, several joined with ' · ' (features/connect/coros-sync.ts). The
// parts it composes itself are translated; what COROS answered stays as it is.
const RATE_LIMITED = 'COROS is rate limiting requests – try again in a few minutes';

function errorPart(t: TFunction, part: string): string {
  if (part === RATE_LIMITED) return t('connect.coros.errors.rateLimited');
  const failed = /^(\d+) activities could not be downloaded$/.exec(part);
  if (failed) return t('connect.coros.errors.downloads', { count: Number(failed[1]) });
  const health = /^Health data: (.+)$/.exec(part);
  if (health) return t('connect.coros.errors.health', { error: errorPart(t, health[1]!) });
  const mobile = /^Sleep & daily data: (.+)$/.exec(part);
  if (mobile) return t('connect.coros.errors.mobile', { error: errorPart(t, mobile[1]!) });
  return part;
}

/** A sync error of the COROS status in the language of the interface (as far as the server's wording is known). */
export const corosErrorText = (t: TFunction, text: string): string =>
  text
    .split(' · ')
    .map((p) => errorPart(t, p))
    .join(' · ');
