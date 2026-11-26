import { gunzip, gzip } from '../lib/gzip';

/**
 * A raw GPS track (one workout route file), columnar. Times are unix seconds (UTC).
 * Optional columns use NaN for missing values.
 */
export interface Track {
  t: Float64Array;
  lat: Float64Array;
  lon: Float64Array;
  ele: Float32Array | null;
  speed: Float32Array | null;
  course: Float32Array | null;
  hAcc: Float32Array | null;
  vAcc: Float32Array | null;
}

const MAGIC = 0x314b5443; // 'CTK1'
const OPTIONAL = ['ele', 'speed', 'course', 'hAcc', 'vAcc'] as const;
/** 360° in 1e-7°. Coordinate deltas take the short way round (|Δ| ≤ 180°): an int32 only holds ±214.7°. */
const TURN = 3_600_000_000;
const HALF = TURN / 2;

/**
 * Compact binary form stored in workout_routes.data (gzip):
 *   u32 magic, u32 n, u32 flags, f64 t0,
 *   i32[n] Δt (ms), i32[n] Δlat (1e-7°), i32[n] Δlon (1e-7°), then f32[n] per optional column present in flags.
 * Delta coding makes the gzip ~4x smaller than raw doubles.
 */
export function encodeTrack(tr: Track): Uint8Array {
  const n = tr.t.length;
  const present = OPTIONAL.filter((k) => tr[k] !== null);
  const size = 4 * 3 + 8 + n * 12 + present.length * n * 4;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint32(o, MAGIC, true);
  dv.setUint32(o + 4, n, true);
  let flags = 0;
  OPTIONAL.forEach((k, i) => {
    if (tr[k] !== null) flags |= 1 << i;
  });
  dv.setUint32(o + 8, flags, true);
  const t0 = n ? tr.t[0]! : 0;
  dv.setFloat64(o + 12, t0, true);
  o = 20;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.round((tr.t[i]! - t0) * 1000);
    dv.setInt32(o, v - prev, true);
    prev = v;
    o += 4;
  }
  for (const col of [tr.lat, tr.lon]) {
    prev = 0;
    for (let i = 0; i < n; i++) {
      const v = Math.round(col[i]! * 1e7);
      let d = v - prev;
      // across the antimeridian (179.9° → -179.9°)
      if (d > HALF) d -= TURN;
      else if (d < -HALF) d += TURN;
      dv.setInt32(o, d, true);
      prev = v;
      o += 4;
    }
  }
  for (const k of present) {
    const col = tr[k]!;
    for (let i = 0; i < n; i++) {
      dv.setFloat32(o, col[i]!, true);
      o += 4;
    }
  }
  return gzip(new Uint8Array(buf));
}

export function decodeTrack(blob: Uint8Array): Track {
  const raw = gunzip(blob);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('Unknown track format');
  const n = dv.getUint32(4, true);
  const flags = dv.getUint32(8, true);
  const t0 = dv.getFloat64(12, true);
  let o = 20;
  const t = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += dv.getInt32(o, true);
    t[i] = t0 + acc / 1000;
    o += 4;
  }
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  for (const col of [lat, lon]) {
    acc = 0;
    for (let i = 0; i < n; i++) {
      acc += dv.getInt32(o, true);
      if (acc > HALF) acc -= TURN;
      else if (acc < -HALF) acc += TURN;
      col[i] = acc / 1e7;
      o += 4;
    }
  }
  const out: Track = { t, lat, lon, ele: null, speed: null, course: null, hAcc: null, vAcc: null };
  OPTIONAL.forEach((k, bit) => {
    if (!(flags & (1 << bit))) return;
    const col = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      col[i] = dv.getFloat32(o, true);
      o += 4;
    }
    out[k] = col;
  });
  return out;
}

/** Concatenate tracks and sort by time (multiple route files of one workout). */
export function mergeTracks(tracks: Track[]): Track {
  if (tracks.length === 1) return tracks[0]!;
  const n = tracks.reduce((s, x) => s + x.t.length, 0);
  const idx: [number, number][] = [];
  tracks.forEach((tr, k) => {
    for (let i = 0; i < tr.t.length; i++) idx.push([k, i]);
  });
  idx.sort((a, b) => tracks[a[0]]!.t[a[1]]! - tracks[b[0]]!.t[b[1]]!);
  const out: Track = {
    t: new Float64Array(n),
    lat: new Float64Array(n),
    lon: new Float64Array(n),
    ele: null,
    speed: null,
    course: null,
    hAcc: null,
    vAcc: null,
  };
  for (const k of OPTIONAL) if (tracks.some((tr) => tr[k])) out[k] = new Float32Array(n).fill(NaN);
  idx.forEach(([k, i], j) => {
    const tr = tracks[k]!;
    out.t[j] = tr.t[i]!;
    out.lat[j] = tr.lat[i]!;
    out.lon[j] = tr.lon[i]!;
    for (const c of OPTIONAL) if (out[c] && tr[c]) out[c]![j] = tr[c]![i]!;
  });
  return out;
}
