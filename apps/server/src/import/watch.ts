import fs from 'node:fs';
import path from 'node:path';
import { getSetting, setSetting } from '../core/settings';
import type { Db } from '../db/db';
import { wasInterrupted, type JobManager } from './jobs';

const SEEN_KEY = 'core.importWatch';
/** Imports of one file that the server or worker interrupted are tried this often in all. */
const MAX_TRIES = 3;

/** Per file name: the signature that is imported (a plain string: done), with the job and attempts while it runs. */
type Seen = string | { sig: string; job?: string; tries?: number };

/**
 * Polls `dir` (CADENCE_IMPORT_DIR) every `intervalMs` and imports new *.zip / *.xml / *.fit files. A file is imported
 * once its size and mtime are unchanged between two polls (i.e. it finished copying); processed files are
 * remembered by name + size + mtime in the athlete's settings, so restarts do not import them again. An import that
 * was interrupted (server stopped, worker crashed) is queued again, up to MAX_TRIES in all; one that failed because
 * of the file, finished or was cancelled is not.
 * Files in the watch folder are never modified or deleted.
 */
export function startImportWatcher(
  db: Db,
  jobs: Pick<JobManager, 'enqueueImport' | 'get'>,
  dir: string,
  athleteId = 1,
  intervalMs = 60_000,
): () => void {
  const candidates = new Map<string, string>();
  const poll = () => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    const seen = getSetting<Record<string, Seen>>(db, athleteId, SEEN_KEY, {});
    let dirty = false;
    const enqueue = (name: string, file: string, size: number) =>
      jobs.enqueueImport(athleteId, file, {
        sourceName: name,
        sizeBytes: size,
        options: { origin: 'watch', deleteAfter: false },
      })?.id;
    for (const name of names) {
      if (name.startsWith('.') || !/\.(zip|xml|fit)$/i.test(name) || /export_cda\.xml$/i.test(name)) continue;
      const file = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size === 0) continue;
      const sig = `${st.size}:${Math.round(st.mtimeMs)}`;
      const prev = seen[name];
      if (prev === sig) continue;
      if (typeof prev === 'object' && prev?.sig === sig) {
        if (!prev.job) continue;
        const job = jobs.get(athleteId, prev.job);
        if (job && (job.status === 'queued' || job.status === 'running')) continue;
        const tries = prev.tries ?? 1;
        if (job?.status === 'failed' && wasInterrupted(job.error) && tries < MAX_TRIES)
          seen[name] = { sig, job: enqueue(name, file, st.size), tries: tries + 1 };
        else seen[name] = sig; // imported, cancelled, or failed because of the file: done with it
        dirty = true;
        continue;
      }
      if (candidates.get(name) !== sig) {
        candidates.set(name, sig); // wait one more poll: the file may still be copying
        continue;
      }
      candidates.delete(name);
      seen[name] = { sig, job: enqueue(name, file, st.size), tries: 1 };
      dirty = true;
    }
    if (dirty) setSetting(db, athleteId, SEEN_KEY, seen);
  };
  const first = setTimeout(poll, Math.min(5_000, intervalMs));
  const timer = setInterval(poll, intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
