import fs from 'node:fs';
import path from 'node:path';
import { getSetting, setSetting } from '../core/settings';
import type { Db } from '../db/db';
import type { JobManager } from './jobs';

const SEEN_KEY = 'core.importWatch';

/**
 * Polls `dir` (CADENCE_IMPORT_DIR) every `intervalMs` and imports new *.zip / *.xml / *.fit files. A file is imported
 * once its size and mtime are unchanged between two polls (i.e. it finished copying); processed files are
 * remembered by name + size + mtime in the athlete's settings, so restarts do not import them again.
 * Files in the watch folder are never modified or deleted.
 */
export function startImportWatcher(
  db: Db,
  jobs: JobManager,
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
    const seen = getSetting<Record<string, string>>(db, athleteId, SEEN_KEY, {});
    let dirty = false;
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
      if (seen[name] === sig) continue;
      if (candidates.get(name) !== sig) {
        candidates.set(name, sig); // wait one more poll: the file may still be copying
        continue;
      }
      candidates.delete(name);
      seen[name] = sig;
      dirty = true;
      jobs.enqueueImport(athleteId, file, {
        sourceName: name,
        sizeBytes: st.size,
        options: { origin: 'watch', deleteAfter: false },
      });
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
