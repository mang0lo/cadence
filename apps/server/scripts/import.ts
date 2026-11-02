/**
 * npm run import -- <export.zip | folder | export.xml> [--db path]
 *
 * In-process import + derive (same code as the server's worker) with a console progress line and final stats.
 * Uses CADENCE_DATA_DIR / the default data dir like the server unless --db is given.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { get, openDb } from '../src/db/db';
import { executeJob } from '../src/import/run-job';
import { emptyStats } from '../src/import/writer';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: 'string' },
  },
});
const base = process.env.INIT_CWD ?? process.cwd();
const input = positionals[0];
if (!input) {
  console.error('Usage: npm run import -- <export.zip | folder | export.xml> [--db path]');
  process.exit(1);
}
const src = path.resolve(base, input);
const config = loadConfig();
const dbPath = values.db ? path.resolve(base, values.db) : config.dbPath;
const db = openDb(dbPath);
db.exec('PRAGMA cache_size = -131072');
migrateAll(db);

const t0 = performance.now();
const tty = process.stdout.isTTY;
let lastLine = 0;
let lastPhase = '';
const stats = emptyStats();
const fmtS = (s: number) =>
  s < 60 ? `${s.toFixed(0)}s` : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
try {
  await executeJob(
    db,
    { id: 'cli', kind: 'import', athleteId: 1, sourcePath: src, options: { origin: 'cli' } },
    {
      progress: (p) => {
        const now = performance.now();
        if (now - lastLine < (tty ? 150 : 2000) && p.phase === lastPhase) return;
        lastLine = now;
        lastPhase = p.phase;
        const el = (now - t0) / 1000;
        const eta = p.progress > 0.02 ? fmtS((el * (1 - p.progress)) / p.progress) : '…';
        const mb = `${(p.stats.bytesProcessed / 1e6).toFixed(0)}/${(p.stats.bytesTotal / 1e6).toFixed(0)} MB`;
        const line = `${(p.progress * 100).toFixed(1).padStart(5)}% ${p.phase.padEnd(8)} ${mb}  ${p.stats.recordsSeen.toLocaleString('en')} records  ${fmtS(el)} (eta ${eta})  ${p.message ?? ''}`;
        if (tty)
          process.stdout.write(
            `\r\x1b[2K${line.slice(0, process.stdout.columns ? process.stdout.columns - 1 : 160)}`,
          );
        else console.log(line);
      },
      checkCancelled: () => {},
      log: () => {},
    },
    stats,
  );
} catch (e) {
  if (tty) process.stdout.write('\n');
  console.error(`Import failed: ${(e as Error).message}`);
  process.exit(1);
}
if (tty) process.stdout.write('\n');
const secs = (performance.now() - t0) / 1000;
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const size = fs.statSync(dbPath).size;
const workouts = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM workouts')!.n;
const ph = stats.phaseSeconds ?? {};
const parseS = ph.parse ?? secs;
console.log(
  [
    `Imported ${path.basename(src)} in ${secs.toFixed(1)} s → ${dbPath} (${(size / 1e6).toFixed(0)} MB)`,
    `  export.xml ${(stats.bytesTotal / 1e6).toFixed(1)} MB parsed in ${parseS.toFixed(1)} s (${(stats.bytesTotal / 1e6 / parseS).toFixed(0)} MB/s)`,
    `  records: ${stats.recordsInserted.toLocaleString('en')} new of ${stats.recordsSeen.toLocaleString('en')} (${Math.round(stats.recordsSeen / parseS).toLocaleString('en')} records/s), ${stats.recordTypes} types`,
    `  workouts: ${stats.workoutsInserted} new of ${stats.workoutsSeen} (${workouts} in db), routes ${stats.routesParsed}, ECGs ${stats.ecgReadings}, summaries ${stats.activitySummaries}, correlations ${stats.correlations}, other ${stats.otherItems}`,
    `  phases: ${Object.entries(ph)
      .map(([k, v]) => `${k} ${v}s`)
      .join(', ')}`,
    ...(stats.warnings.length ? ['  warnings:', ...stats.warnings.slice(0, 20).map((w) => `   - ${w}`)] : []),
  ].join('\n'),
);
db.close();
