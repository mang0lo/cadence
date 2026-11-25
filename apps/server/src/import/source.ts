import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import yauzl from 'yauzl';

/**
 * Uniform access to an Apple Health export, given as
 *  - the export.zip from the Health app (zip64 / data descriptors are handled by yauzl),
 *  - the unzipped folder (`apple_health_export/` or its parent), or
 *  - a bare export.xml (route / ECG files are resolved relative to it).
 *
 * Paths are relative to the export root (the directory of export.xml), '/'-separated, compared case-insensitively.
 */
export interface ExportFile {
  path: string;
  size: number;
}

export interface ExportSource {
  kind: 'zip' | 'dir' | 'xml';
  /** Display name (file name of the input). */
  name: string;
  /** Uncompressed size of export.xml in bytes. */
  xmlSize: number;
  /** Path of export.xml inside the input (for messages). */
  xmlPath: string;
  openXml(): Promise<Readable>;
  /** Files directly or indirectly below `dir` (e.g. 'workout-routes') with the given extension. */
  list(dir: string, ext: string): ExportFile[];
  find(relPath: string): ExportFile | null;
  read(relPath: string): Promise<Buffer>;
  close(): void;
}

/** Normalise a FileReference path ('/workout-routes/route_….gpx') to a lookup key. */
export function normalizeRelPath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^\.?\/+/, '')
    .replace(/\/{2,}/g, '/');
}

const key = (p: string) => normalizeRelPath(p).toLowerCase();

function isExportXml(name: string): boolean {
  return path.posix.basename(name).toLowerCase() === 'export.xml';
}

export class ImportInputError extends Error {}

/** export_cda.xml (clinical document, next to export.xml in the unzipped export) is no Apple Health export.xml. */
export function isClinicalDocument(name: string): boolean {
  return /export_cda\.xml$/i.test(name);
}

export async function openExportSource(input: string): Promise<ExportSource> {
  let st: fs.Stats;
  try {
    st = fs.statSync(input);
  } catch {
    throw new ImportInputError(`File not found: ${input}`);
  }
  if (st.isDirectory()) return openDir(input);
  if (isClinicalDocument(input))
    throw new ImportInputError('export_cda.xml is the clinical document export: choose export.xml or the export.zip');
  const fd = fs.openSync(input, 'r');
  const head = Buffer.alloc(4);
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  if (head[0] === 0x50 && head[1] === 0x4b) return openZip(input);
  return openXmlFile(input, st.size);
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

async function openZip(file: string): Promise<ExportSource> {
  const zip = await yauzl.openPromise(file, {
    lazyEntries: true,
    autoClose: false,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: false,
  });
  const entries: yauzl.Entry[] = [];
  try {
    for await (const e of zip.eachEntry()) if (!e.fileName.endsWith('/')) entries.push(e);
  } catch (err) {
    zip.close();
    throw new ImportInputError(`Not a readable zip file: ${(err as Error).message}`);
  }
  const candidates = entries
    .filter((e) => isExportXml(e.fileName))
    .sort(
      (a, b) =>
        a.fileName.split('/').length - b.fileName.split('/').length || a.fileName.length - b.fileName.length,
    );
  const xml = candidates[0];
  if (!xml) {
    zip.close();
    throw new ImportInputError(
      'This zip does not contain an export.xml (expected an Apple Health export.zip)',
    );
  }
  const rootDir = path.posix.dirname(xml.fileName);
  const prefix = rootDir === '.' ? '' : rootDir + '/';
  const byKey = new Map<string, yauzl.Entry>();
  for (const e of entries) {
    if (!e.fileName.startsWith(prefix)) continue;
    byKey.set(key(e.fileName.slice(prefix.length)), e);
  }
  const rel = (e: yauzl.Entry) => e.fileName.slice(prefix.length);
  const openEntry = async (e: yauzl.Entry): Promise<Readable> => {
    if (e.compressionMethod === 8 && !e.isEncrypted()) {
      const raw = await zip.openReadStreamPromise(e, { decodeFileData: false });
      // Own inflater: 1 MB output chunks instead of zlib's default 16 KB.
      const inflate = zlib.createInflateRaw({ chunkSize: 1 << 20 });
      raw.on('error', (err) => inflate.destroy(err));
      return raw.pipe(inflate);
    }
    return zip.openReadStreamPromise(e);
  };
  return {
    kind: 'zip',
    name: path.basename(file),
    xmlSize: xml.uncompressedSize,
    xmlPath: xml.fileName,
    openXml: () => openEntry(xml),
    list(dir, ext) {
      const d = key(dir).replace(/\/?$/, '/');
      const out: ExportFile[] = [];
      for (const [k, e] of byKey)
        if (k.startsWith(d) && k.endsWith(ext)) out.push({ path: rel(e), size: e.uncompressedSize });
      return out.sort((a, b) => a.path.localeCompare(b.path));
    },
    find(p) {
      const e = byKey.get(key(p));
      return e ? { path: rel(e), size: e.uncompressedSize } : null;
    },
    async read(p) {
      const e = byKey.get(key(p));
      if (!e) throw new Error(`Missing file in export: ${p}`);
      const s = await openEntry(e);
      const chunks: Buffer[] = [];
      for await (const c of s) chunks.push(c as Buffer);
      return Buffer.concat(chunks);
    },
    close: () => zip.close(),
  };
}

// ---------------------------------------------------------------------------
// directory / bare export.xml
// ---------------------------------------------------------------------------

function findExportXml(dir: string, depth = 0): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const hit = names.find((n) => n.toLowerCase() === 'export.xml');
  if (hit && fs.statSync(path.join(dir, hit)).isFile()) return path.join(dir, hit);
  if (depth >= 2) return null;
  // prefer apple_health_export/ (any case), then other sub folders
  const subs = names
    .filter(
      (n) => !n.startsWith('.') && fs.statSync(path.join(dir, n), { throwIfNoEntry: false })?.isDirectory(),
    )
    .sort((a, b) => Number(!/health/i.test(a)) - Number(!/health/i.test(b)));
  for (const s of subs) {
    const f = findExportXml(path.join(dir, s), depth + 1);
    if (f) return f;
  }
  return null;
}

async function openDir(dir: string): Promise<ExportSource> {
  const xml = findExportXml(dir);
  if (!xml) throw new ImportInputError(`No export.xml found in ${dir}`);
  const src = await openXmlFile(xml, fs.statSync(xml).size);
  return { ...src, kind: 'dir', name: path.basename(dir) };
}

async function openXmlFile(file: string, size: number): Promise<ExportSource> {
  const root = path.dirname(file);
  const index = new Map<string, ExportFile & { abs: string }>();
  const indexed = new Set<string>();
  // Lazily index (case-insensitively) the sub folders we are asked about.
  const indexDir = (rel: string) => {
    const first = key(rel).split('/')[0]!;
    if (indexed.has(first)) return;
    indexed.add(first);
    let names: string[] = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      return;
    }
    const actual = names.find((n) => n.toLowerCase() === first);
    if (!actual) return;
    const walk = (absDir: string, relDir: string) => {
      for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
        const abs = path.join(absDir, ent.name);
        const r = relDir ? `${relDir}/${ent.name}` : ent.name;
        if (ent.isDirectory()) walk(abs, r);
        else if (ent.isFile()) index.set(key(r), { path: r, size: fs.statSync(abs).size, abs });
      }
    };
    const abs = path.join(root, actual);
    if (fs.statSync(abs).isDirectory()) walk(abs, actual);
  };
  return {
    kind: 'xml',
    name: path.basename(file),
    xmlSize: size,
    xmlPath: file,
    openXml: async () => fs.createReadStream(file, { highWaterMark: 1 << 20 }),
    list(dir, ext) {
      indexDir(dir);
      const d = key(dir).replace(/\/?$/, '/');
      const out: ExportFile[] = [];
      for (const [k, f] of index)
        if (k.startsWith(d) && k.endsWith(ext)) out.push({ path: f.path, size: f.size });
      return out.sort((a, b) => a.path.localeCompare(b.path));
    },
    find(p) {
      indexDir(p);
      const f = index.get(key(p));
      return f ? { path: f.path, size: f.size } : null;
    },
    async read(p) {
      indexDir(p);
      const f = index.get(key(p));
      if (!f) throw new Error(`Missing file in export: ${p}`);
      return fs.promises.readFile(f.abs);
    },
    close() {},
  };
}
