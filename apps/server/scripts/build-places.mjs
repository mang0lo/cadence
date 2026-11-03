// Builds src/lib/places/places.bin.gz — the offline gazetteer used to name routes after real places.
//
//   npm install --no-save all-the-cities@3.1.0   (anywhere; GeoNames cities ≥ 1000 inhabitants)
//   node apps/server/scripts/build-places.mjs <path to node_modules/all-the-cities>
//
// Data: GeoNames (https://www.geonames.org), CC BY 4.0, via the all-the-cities package.
// Format (little endian, gzip): "CPL1", count n, Int32 lat×1e5 [n], Int32 lon×1e5 [n],
// Uint8 round(log10(population)×30) [n], Uint8 kind [n] (0 town/city/village, 1 section of a city),
// country codes (2 ASCII bytes each), then the UTF-8 names separated by "\n".
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

const src = process.argv[2];
if (!src) {
  console.error('usage: node build-places.mjs <path to all-the-cities>');
  process.exit(1);
}
const cities = createRequire(import.meta.url)(path.resolve(src));
// historical, abandoned, destroyed or religious places are no useful names for a route
const SKIP = new Set(['PPLW', 'PPLQ', 'PPLH', 'PPLCH', 'PPLR']);
const rows = cities
  .filter((c) => !SKIP.has(c.featureCode) && c.name && c.loc?.coordinates)
  .map((c) => ({
    lat: Math.round(c.loc.coordinates[1] * 1e5),
    lon: Math.round(c.loc.coordinates[0] * 1e5),
    pop: Math.max(0, Math.min(255, Math.round(Math.log10(Math.max(1, c.population || 1)) * 30))),
    kind: c.featureCode === 'PPLX' ? 1 : 0,
    country: (c.country || '--').slice(0, 2).padEnd(2, '-'),
    name: c.name.replace(/\n/g, ' ').trim(),
  }))
  // sorted by latitude: neighbouring rows share digits, which compresses better
  .sort((a, b) => a.lat - b.lat || a.lon - b.lon);

const n = rows.length;
const head = Buffer.alloc(8);
head.write('CPL1', 0, 'ascii');
head.writeUInt32LE(n, 4);
const lat = Buffer.alloc(4 * n);
const lon = Buffer.alloc(4 * n);
const pop = Buffer.alloc(n);
const kind = Buffer.alloc(n);
const country = Buffer.alloc(2 * n);
rows.forEach((r, i) => {
  lat.writeInt32LE(r.lat, 4 * i);
  lon.writeInt32LE(r.lon, 4 * i);
  pop[i] = r.pop;
  kind[i] = r.kind;
  country.write(r.country, 2 * i, 'ascii');
});
const names = Buffer.from(rows.map((r) => r.name).join('\n'), 'utf8');
const raw = Buffer.concat([head, lat, lon, pop, kind, country, names]);
const out = new URL('../src/lib/places/places.bin.gz', import.meta.url);
fs.mkdirSync(new URL('.', out), { recursive: true });
fs.writeFileSync(out, zlib.gzipSync(raw, { level: 9 }));
console.log(`${n} places, ${(raw.length / 1e6).toFixed(2)} MB raw → ${(fs.statSync(out).size / 1e6).toFixed(2)} MB`);
