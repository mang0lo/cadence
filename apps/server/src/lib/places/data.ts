import fs from 'node:fs';

/**
 * The gzipped gazetteer (see scripts/build-places.mjs). Read from disk when running from source (dev, tests); the
 * production bundle embeds the file instead (build.mjs replaces this module), so dist/index.js stays one file.
 */
export function placesBytes(): Uint8Array {
  return fs.readFileSync(new URL('./places.bin.gz', import.meta.url));
}
