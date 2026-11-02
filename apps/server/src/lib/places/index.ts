/**
 * Offline gazetteer: names a GPS position after the nearest town, village or city district (GeoNames places with at
 * least 1,000 inhabitants, CC BY 4.0). Nothing leaves the machine. Loaded lazily (~135k places, ~30 ms) and indexed
 * on a 0.5° grid.
 */
import zlib from 'node:zlib';
import { haversine } from '../geo';
import { placesBytes } from './data';

export interface Place {
  name: string;
  /** ISO 3166-1 alpha-2 country code. */
  country: string;
  lat: number;
  lon: number;
  /** Approximate population (±8 %). */
  population: number;
  /** A section of a city (e.g. "Warnemünde", "Kreuzberg") rather than a town of its own. */
  section: boolean;
}

interface Gazetteer {
  n: number;
  lat: Int32Array;
  lon: Int32Array;
  popLog: Uint8Array;
  kind: Uint8Array;
  country: Uint8Array;
  nameStart: Uint32Array;
  names: Buffer;
  grid: Map<number, number[]>;
}

const CELL = 0.5;
const cellKey = (lat: number, lon: number) => Math.floor((lat + 90) / CELL) * 1000 + Math.floor((lon + 180) / CELL);

let loaded: Gazetteer | null = null;

function load(): Gazetteer {
  if (loaded) return loaded;
  const raw = zlib.gunzipSync(placesBytes());
  if (raw.toString('ascii', 0, 4) !== 'CPL1') throw new Error('Invalid gazetteer data');
  const n = raw.readUInt32LE(4);
  let o = 8;
  const ints = (count: number) => {
    const a = new Int32Array(count);
    for (let i = 0; i < count; i++) a[i] = raw.readInt32LE(o + 4 * i);
    o += 4 * count;
    return a;
  };
  const lat = ints(n);
  const lon = ints(n);
  const popLog = new Uint8Array(raw.subarray(o, o + n));
  o += n;
  const kind = new Uint8Array(raw.subarray(o, o + n));
  o += n;
  const country = new Uint8Array(raw.subarray(o, o + 2 * n));
  o += 2 * n;
  const names = raw.subarray(o);
  const nameStart = new Uint32Array(n + 1);
  let k = 0;
  for (let i = 0; i < names.length && k < n; i++) if (names[i] === 10) nameStart[++k] = i + 1;
  nameStart[n] = names.length + 1;
  const grid = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const key = cellKey(lat[i]! / 1e5, lon[i]! / 1e5);
    const list = grid.get(key);
    if (list) list.push(i);
    else grid.set(key, [i]);
  }
  loaded = { n, lat, lon, popLog, kind, country, nameStart, names, grid };
  return loaded;
}

function placeAt(g: Gazetteer, i: number): Place {
  return {
    name: g.names.toString('utf8', g.nameStart[i]!, g.nameStart[i + 1]! - 1),
    country: String.fromCharCode(g.country[2 * i]!, g.country[2 * i + 1]!),
    lat: g.lat[i]! / 1e5,
    lon: g.lon[i]! / 1e5,
    population: Math.round(10 ** (g.popLog[i]! / 30)),
    section: g.kind[i] === 1,
  };
}

/**
 * The place a position is best named after: the nearest one within `maxKm`, where bigger places count as closer
 * (distance / log10(population)), so a village next to a city wins only when it is clearly nearer.
 */
export function nearestPlace(lat: number, lon: number, maxKm = 30): Place | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const g = load();
  const span = Math.ceil(maxKm / 111 / CELL) + 1;
  const ci = Math.floor((lat + 90) / CELL);
  const cj = Math.floor((lon + 180) / CELL);
  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const spanLon = Math.ceil(span / cosLat);
  let best = -1;
  let bestScore = Infinity;
  for (let di = -span; di <= span; di++)
    for (let dj = -spanLon; dj <= spanLon; dj++) {
      const j = (((cj + dj) % 720) + 720) % 720;
      const list = g.grid.get((ci + di) * 1000 + j);
      if (!list) continue;
      for (const i of list) {
        const km = haversine(lat, lon, g.lat[i]! / 1e5, g.lon[i]! / 1e5) / 1000;
        if (km > maxKm) continue;
        const score = (km + 0.3) / Math.max(1, g.popLog[i]! / 30);
        if (score < bestScore) {
          bestScore = score;
          best = i;
        }
      }
    }
  return best < 0 ? null : placeAt(g, best);
}
