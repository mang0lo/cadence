/** Google encoded polyline (precision 5) → [lat, lon][] */
export function decodePolyline(encoded: string, precision = 5): [number, number][] {
  const factor = 10 ** precision;
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    for (let k = 0; k < 2; k++) {
      let result = 0;
      let shift = 0;
      let b: number;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && index < encoded.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += delta;
      else lon += delta;
    }
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

/** [lat, lon][] → GeoJSON LineString coordinates ([lon, lat][]). */
export const toLngLat = (points: [number, number][]): [number, number][] => points.map(([la, lo]) => [lo, la]);

/** Bounds as [minLon, minLat, maxLon, maxLat]. */
export function boundsOf(points: [number, number][]): [number, number, number, number] | null {
  if (!points.length) return null;
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const [la, lo] of points) {
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
    if (lo < minLon) minLon = lo;
    if (lo > maxLon) maxLon = lo;
  }
  return [minLon, minLat, maxLon, maxLat];
}
