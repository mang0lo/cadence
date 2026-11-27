import zlib from 'node:zlib';

/**
 * Compression level of stored blobs. Level 1 compresses workout streams about 6x faster than level 6 for blobs about
 * 16 % bigger (routes: 2x faster, 2 % bigger), which halves the analysis step of an import or rebuild. Blobs of
 * any level decode the same way.
 */
const LEVEL = 1;

/** gzip(JSON) as stored in BLOB columns (workout_streams.data, …). */
export function gzipJson(value: unknown, level = LEVEL): Uint8Array {
  return zlib.gzipSync(Buffer.from(JSON.stringify(value)), { level });
}

export function gunzipJson<T>(blob: Uint8Array): T {
  return JSON.parse(zlib.gunzipSync(blob).toString('utf8')) as T;
}

/** gzip of a little-endian Float32Array (ECG samples, histograms). */
export function gzipFloat32(values: ArrayLike<number>, level = LEVEL): Uint8Array {
  const arr = values instanceof Float32Array ? values : Float32Array.from(values as ArrayLike<number>);
  return zlib.gzipSync(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength), { level });
}

export function gunzipFloat32(blob: Uint8Array): Float32Array {
  const buf = zlib.gunzipSync(blob);
  // copy into an aligned buffer
  const out = new Float32Array(buf.byteLength >> 2);
  new Uint8Array(out.buffer).set(buf.subarray(0, out.byteLength));
  return out;
}

export function gzip(data: Uint8Array, level = LEVEL): Uint8Array {
  return zlib.gzipSync(data, { level });
}

export function gunzip(data: Uint8Array): Buffer {
  return zlib.gunzipSync(data);
}
