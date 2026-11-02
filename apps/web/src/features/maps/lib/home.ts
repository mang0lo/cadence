export type BBox = [minLon: number, minLat: number, maxLon: number, maxLat: number];

export const unionBox = (a: BBox | null, b: BBox): BBox =>
  a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b;

export const sameBounds = (a: BBox | null, b: BBox | null): boolean =>
  !!a && !!b && a.every((v, i) => Math.abs(v - b[i]!) < 1e-4);

/**
 * Bounds of the "home region": the densest 0.5° cell of anchor points plus every item whose anchor lies within ~1°
 * of it. A single run / trip in another country therefore does not zoom the map out to the whole world.
 */
export function homeRegion<T>(
  items: T[],
  anchor: (item: T) => [lon: number, lat: number],
  box: (item: T) => BBox,
): BBox | null {
  if (!items.length) return null;
  const cell = 0.5;
  const counts = new Map<string, { n: number; lon: number; lat: number }>();
  for (const it of items) {
    const [lon, lat] = anchor(it);
    const key = `${Math.floor(lon / cell)},${Math.floor(lat / cell)}`;
    const c = counts.get(key);
    if (c) c.n++;
    else counts.set(key, { n: 1, lon, lat });
  }
  let best = { n: 0, lon: 0, lat: 0 };
  for (const c of counts.values()) if (c.n > best.n) best = c;
  let out: BBox | null = null;
  for (const it of items) {
    const [lon, lat] = anchor(it);
    if (Math.abs(lon - best.lon) <= 1 && Math.abs(lat - best.lat) <= 1) out = unionBox(out, box(it));
  }
  return out;
}
