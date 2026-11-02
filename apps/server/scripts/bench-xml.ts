/**
 * Benchmark of the streaming XML scanner: `tsx scripts/bench-xml.ts <export.zip | export.xml>`
 *
 * Loads export.xml into memory first (as 1 MB Buffers, like the importer receives them), then measures
 *  1. scanner only (no-op handler),
 *  2. scanner + Apple Health element mapping (counting sink, no database),
 * so inflate and disk I/O are excluded.
 */
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { AppleHealthHandler, type HealthSink } from '../src/import/parser';
import { openExportSource } from '../src/import/source';
import { XmlScanner, type XmlHandler } from '../src/import/xml';

const file = process.argv[2];
if (!file) {
  console.error('Usage: tsx scripts/bench-xml.ts <export.zip | export.xml>');
  process.exit(1);
}
const src = await openExportSource(path.resolve(process.env.INIT_CWD ?? process.cwd(), file));
const chunks: Buffer[] = [];
let pending: Buffer[] = [];
let pendingLen = 0;
for await (const c of await src.openXml()) {
  pending.push(c as Buffer);
  pendingLen += (c as Buffer).length;
  if (pendingLen >= 1 << 20) {
    chunks.push(Buffer.concat(pending));
    pending = [];
    pendingLen = 0;
  }
}
if (pending.length) chunks.push(Buffer.concat(pending));
src.close();
const bytes = chunks.reduce((a, c) => a + c.length, 0);
console.log(`export.xml: ${(bytes / 1e6).toFixed(1)} MB in ${chunks.length} chunks`);

function run(label: string, handler: XmlHandler, rounds = 3): void {
  let best = Infinity;
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    const dec = new StringDecoder('utf8');
    const s = new XmlScanner(handler);
    for (const c of chunks) s.write(dec.write(c));
    s.end();
    best = Math.min(best, performance.now() - t0);
  }
  console.log(
    `${label.padEnd(36)} ${(bytes / 1e6 / (best / 1000)).toFixed(0).padStart(5)} MB/s  (${(best / 1000).toFixed(2)} s)`,
  );
}

let elements = 0;
run('scanner only', {
  open: () => {
    elements++;
  },
  close: () => {},
});
let records = 0;
const sink: HealthSink = {
  exportInfo() {},
  me() {},
  record() {
    records++;
  },
  correlation() {},
  workout() {},
  activitySummary() {},
  other() {},
};
run('scanner + Apple Health mapping', new AppleHealthHandler(sink));
console.log(
  `${(elements / 3).toLocaleString('en')} elements, ${(records / 3).toLocaleString('en')} records per pass`,
);
