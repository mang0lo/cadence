import { valueAtDistance, type MapsSegmentSource } from '@cadence/shared';

type Points = MapsSegmentSource['points'];

/** [lon, lat] at a distance along the route. */
export function pointAt(p: Points, d: number): [number, number] {
  return [valueAtDistance(p.dist, p.lon, d) ?? 0, valueAtDistance(p.dist, p.lat, d) ?? 0];
}

/** The part of the route between two distances as [lon, lat][] (interpolated ends included). */
export function slicePoints(p: Points, from: number, to: number): [number, number][] {
  const out: [number, number][] = [pointAt(p, from)];
  for (let i = 0; i < p.dist.length; i++) {
    const d = p.dist[i]!;
    if (d > from && d < to) out.push([p.lon[i]!, p.lat[i]!]);
  }
  out.push(pointAt(p, to));
  return out;
}

/** Seconds between two distances of the route (from the recorded timestamps), or null. */
export function elapsedBetween(p: Points, from: number, to: number): number | null {
  const a = valueAtDistance(p.dist, p.t, from);
  const b = valueAtDistance(p.dist, p.t, to);
  return a === null || b === null ? null : Math.max(0, b - a);
}

/** Grade in percent between two profile positions (±`spanM`), for tooltips. */
export function gradeAt(dist: number[], ele: (number | null)[], d: number, spanM = 25): number | null {
  const a = valueAtDistance(dist, ele, Math.max(0, d - spanM));
  const b = valueAtDistance(dist, ele, Math.min(dist[dist.length - 1] ?? 0, d + spanM));
  const run = Math.min(dist[dist.length - 1] ?? 0, d + spanM) - Math.max(0, d - spanM);
  return a === null || b === null || run <= 0 ? null : ((b - a) / run) * 100;
}

/**
 * Decimals for the labels of a distance axis (km or mi) from 0 to `max`: ECharts steps it by 1, 2, 3 or 5 × 10ⁿ near
 * max / splitNumber, so a 150 m segment steps by 0.03 km and needs two decimals, a 12 km climb none.
 */
export const distanceAxisDigits = (max: number, splitNumber = 4): number =>
  max > 0 ? Math.max(0, Math.ceil(-Math.log10(max / splitNumber))) : 0;
