import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openFitSource } from '../src/import/fit/import';
import { openExportSource } from '../src/import/source';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-zip-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write a zip (deflated entries) and return its bytes. */
async function writeZip(file: string, entries: [string, string | Buffer][]): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, data] of entries) zip.addBuffer(Buffer.from(data), name);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const c of zip.outputStream) chunks.push(c as Buffer);
  const buf = Buffer.concat(chunks);
  fs.writeFileSync(file, buf);
  return buf;
}

/** Let the central directory claim another uncompressed size for `name` (what a crafted zip does). */
function declareSize(buf: Buffer, name: string, size: number): void {
  for (let i = buf.length - 46; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue;
    const len = buf.readUInt16LE(i + 28);
    if (buf.toString('utf8', i + 46, i + 46 + len) !== name) continue;
    buf.writeUInt32LE(size, i + 24);
    return;
  }
  throw new Error(`No central directory entry ${name}`);
}

/** Open file descriptors of this process (vitest runs each test file in its own process). */
const openFds = () => fs.readdirSync('/dev/fd').length;
const settle = () => new Promise((r) => setTimeout(r, 50));

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">\n';
const GPX = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1"><trk><trkseg>${Array.from(
  { length: 400 },
  (_, i) => `<trkpt lon="8.${5400 + i}" lat="47.${3700 + i}"><ele>400</ele><time>2026-05-01T07:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z</time></trkpt>`,
).join('')}</trkseg></trk></gpx>`;

describe('zip exports', () => {
  it('let go of the zip file when export.xml is not read to the end (cancel, error)', async () => {
    const zipPath = path.join(dir, 'export.zip');
    // hardly compressible, so the zip is still being read when the reader stops
    const filler = randomBytes(2 * 1024 * 1024).toString('hex');
    await writeZip(zipPath, [['apple_health_export/export.xml', `${XML_HEAD}<!-- ${filler} -->\n</HealthData>\n`]]);
    const before = openFds();
    const src = await openExportSource(zipPath);
    let chunks = 0;
    for await (const _ of await src.openXml()) if (++chunks === 1) break;
    src.close();
    await settle();
    expect(chunks).toBe(1);
    expect(openFds()).toBe(before);
  });

  it('never buffer more of an entry than the zip declares', async () => {
    const zipPath = path.join(dir, 'export.zip');
    const routes = 'apple_health_export/workout-routes/';
    const buf = await writeZip(zipPath, [
      ['apple_health_export/export.xml', `${XML_HEAD}</HealthData>\n`],
      [`${routes}route_1.gpx`, GPX],
      [`${routes}route_2.gpx`, GPX],
      [`${routes}route_3.gpx`, GPX],
    ]);
    // route 1 claims to be smaller than it inflates to, route 2 claims 3 GB
    declareSize(buf, `${routes}route_1.gpx`, 1000);
    declareSize(buf, `${routes}route_2.gpx`, 3 * 1024 ** 3);
    fs.writeFileSync(zipPath, buf);
    const before = openFds();
    const src = await openExportSource(zipPath);
    expect(src.find('workout-routes/route_1.gpx')?.size).toBe(1000);
    await expect(src.read('workout-routes/route_1.gpx')).rejects.toThrow(/More data than the zip declares/);
    await expect(src.read('workout-routes/route_2.gpx')).rejects.toThrow(/too large/);
    expect((await src.read('workout-routes/route_3.gpx')).toString('utf8')).toBe(GPX);
    src.close();
    await settle();
    expect(openFds()).toBe(before);
  });

  it('of FIT files never read an entry that claims gigabytes', async () => {
    const zipPath = path.join(dir, 'activities.zip');
    const buf = await writeZip(zipPath, [
      ['a.fit', randomBytes(64)],
      ['b.fit', randomBytes(64)],
    ]);
    // a crafted zip (deflate inflates ~1000:1) would make the reader buffer all of it
    declareSize(buf, 'b.fit', 3 * 1024 ** 3);
    fs.writeFileSync(zipPath, buf);
    const src = (await openFitSource(zipPath))!;
    expect(src.files.map((f) => f.path)).toEqual(['a.fit', 'b.fit']);
    expect((await src.files[0]!.read()).length).toBe(64);
    await expect(src.files[1]!.read()).rejects.toThrow(/too large/);
    src.close();
  });
});
