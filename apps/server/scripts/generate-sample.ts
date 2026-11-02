/**
 * npm run sample -- [--out path] [--size small|medium|large] [--seed N] [--end YYYY-MM-DD]
 *
 * Writes a synthetic, deterministic Apple Health export.zip (default <repo>/data/sample/export.zip).
 * Relative --out paths are resolved against the directory npm was started from (INIT_CWD).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { generateSample, type SampleSize } from './sample/generate';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    size: { type: 'string', default: 'medium' },
    seed: { type: 'string', default: '42' },
    end: { type: 'string' },
  },
});
const size = values.size as SampleSize;
if (!['small', 'medium', 'large'].includes(size)) {
  console.error(`--size must be small, medium or large (got ${values.size})`);
  process.exit(1);
}
const base = process.env.INIT_CWD ?? process.cwd();
const out = values.out ? path.resolve(base, values.out) : path.join(repo, 'data', 'sample', 'export.zip');

const r = await generateSample({
  out,
  size,
  seed: Number(values.seed),
  endDate: values.end,
  log: (m) => console.log(m),
});
const rel = path.relative(base, r.file);
console.log(
  `\n✔ ${rel && !rel.startsWith('..') ? rel : r.file}\n` +
    `  ${r.firstDay} … ${r.lastDay} (${r.days} days), ${r.records.toLocaleString('en')} records, ${r.workouts} workouts, ` +
    `${r.routes} routes, ${r.ecgs} ECGs\n` +
    `  export.xml ${(r.xmlBytes / 1e6).toFixed(1)} MB, zip ${(r.zipBytes / 1e6).toFixed(1)} MB, ${(r.ms / 1000).toFixed(1)} s`,
);
