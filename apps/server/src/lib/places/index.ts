/**
 * Offline gazetteer: names a GPS position after the nearest town, village or city district (GeoNames places with at
 * least 1,000 inhabitants, CC BY 4.0). Nothing leaves the machine. Loaded lazily (~135k places, ~30 ms) and indexed
 * on a 0.5° grid.
 */
import zlib from 'node:zlib';
import { decodePolylineParts, haversine } from '../geo';
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

const nameCache = new Map<string, string | null>();

/**
 * Name of the place at a position (see nearestPlace), cached on a ~100 m grid: lists name the same start points over
 * and over.
 */
export function placeNameAt(lat: number | null, lon: number | null, maxKm = 25): string | null {
  if (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const key = `${lat.toFixed(3)},${lon.toFixed(3)},${maxKm}`;
  const hit = nameCache.get(key);
  if (hit !== undefined) return hit;
  const name = nearestPlace(lat, lon, maxKm)?.name ?? null;
  if (nameCache.size >= 20_000) nameCache.clear();
  nameCache.set(key, name);
  return name;
}

/** A village or district counts as passed through within this distance of its center. */
const VIA_NEAR_KM = 2;
/** Cities from 100,000 inhabitants are found from farther away: 3 km, plus 4 km per factor ten (Berlin ≈ 9 km). */
const VIA_CITY_POPLOG = 150;
const viaCityKm = (popLog: number) => 3 + (4 * (popLog - VIA_CITY_POPLOG)) / 30;

const aroundCache = new Map<string, string[]>();

/**
 * The places a position lies in: the nearest town, village or district within VIA_NEAR_KM, and every city whose
 * center is close enough for its size — so a ride through Kreuzberg is also a ride through Berlin.
 */
export function placesAround(lat: number, lon: number): string[] {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = aroundCache.get(key);
  if (hit) return hit;
  const g = load();
  const ci = Math.floor((lat + 90) / CELL);
  const cj = Math.floor((lon + 180) / CELL);
  let near = -1;
  let nearKm = VIA_NEAR_KM;
  const cities: number[] = [];
  for (let di = -1; di <= 1; di++)
    for (let dj = -1; dj <= 1; dj++) {
      const list = g.grid.get((ci + di) * 1000 + ((((cj + dj) % 720) + 720) % 720));
      if (!list) continue;
      for (const i of list) {
        const km = haversine(lat, lon, g.lat[i]! / 1e5, g.lon[i]! / 1e5) / 1000;
        if (km <= nearKm) {
          nearKm = km;
          near = i;
        }
        if (g.popLog[i]! >= VIA_CITY_POPLOG && km <= viaCityKm(g.popLog[i]!)) cities.push(i);
      }
    }
  const names = [...new Set([...(near >= 0 ? [near] : []), ...cities].map((i) => placeAt(g, i).name))];
  if (aroundCache.size >= 50_000) aroundCache.clear();
  aroundCache.set(key, names);
  return names;
}

/** Every place a route (encoded polyline, possibly in parts) passes through, in the order of the route. */
export function placesAlong(polyline: string | null, stepM = 800): string[] {
  if (!polyline) return [];
  const out = new Set<string>();
  for (const part of decodePolylineParts(polyline)) {
    for (let i = 0; i < part.length; i++) {
      const [lat, lon] = part[i]!;
      for (const n of placesAround(lat, lon)) out.add(n);
      const next = part[i + 1];
      if (!next) continue;
      // the stored route is simplified: long straight stretches are sampled in between
      const steps = Math.floor(haversine(lat, lon, next[0], next[1]) / stepM);
      for (let k = 1; k <= steps; k++) {
        const f = k / (steps + 1);
        for (const n of placesAround(lat + (next[0] - lat) * f, lon + (next[1] - lon) * f)) out.add(n);
      }
    }
  }
  return [...out];
}

/** Stored form of the places of a route: "|Hannover|Berlin|" (searchable with LIKE), null without any. */
export const placesColumn = (names: string[]): string | null => (names.length ? `|${names.join('|')}|` : null);

const countryCache = new Map<string, string | null>();

/**
 * ISO country code of the place a position is named after (see nearestPlace), looked up on a ~100 m grid: fine
 * enough for twin towns on a border (Kreuzlingen / Konstanz), coarse enough to cache repeated routes.
 */
function countryAt(lat: number, lon: number): string | null {
  const la = Math.round(lat * 1000) / 1000;
  const lo = Math.round(lon * 1000) / 1000;
  const key = `${la},${lo}`;
  const hit = countryCache.get(key);
  if (hit !== undefined) return hit;
  const c = nearestPlace(la, lo, 30)?.country ?? null;
  const code = c && /^[A-Z]{2}$/.test(c) ? c : null;
  if (countryCache.size >= 50_000) countryCache.clear();
  countryCache.set(key, code);
  return code;
}

/** ISO country codes along a route (start, end and a point every few kilometers), in order. */
export function countriesAlong(polyline: string | null, stepM = 4000): string[] {
  if (!polyline) return [];
  const out = new Set<string>();
  const add = (lat: number, lon: number) => {
    const c = countryAt(lat, lon);
    if (c) out.add(c);
  };
  for (const part of decodePolylineParts(polyline))
    for (let i = 0; i < part.length; i++) {
      const [lat, lon] = part[i]!;
      const next = part[i + 1];
      if (i === 0 || !next) add(lat, lon);
      if (!next) continue;
      const steps = Math.floor(haversine(lat, lon, next[0], next[1]) / stepM);
      for (let k = 1; k <= steps; k++) {
        const f = k / (steps + 1);
        add(lat + (next[0] - lat) * f, lon + (next[1] - lon) * f);
      }
    }
  return [...out];
}

let countryNames: Map<string, string[]> | null = null;

/** Country codes whose English or German name contains the search text ("ital" → IT, "österreich" → AT). */
export function countrySearchCodes(q: string): string[] {
  const s = q.trim().toLowerCase();
  if (s.length < 3) return [];
  if (!countryNames) {
    countryNames = new Map();
    const names = [new Intl.DisplayNames(['en'], { type: 'region' }), new Intl.DisplayNames(['de'], { type: 'region' })];
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const a of A)
      for (const b of A) {
        const code = a + b;
        const list = names.flatMap((n) => {
          try {
            const name = n.of(code);
            return name && name !== code ? [name.toLowerCase()] : [];
          } catch {
            return [];
          }
        });
        if (list.length) countryNames.set(code, list);
      }
  }
  return [...countryNames].filter(([, list]) => list.some((n) => n.includes(s))).map(([code]) => code);
}
