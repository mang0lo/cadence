import { bearing, haversine } from '../../src/lib/geo';
import type { Waypoint } from './routes-data';

const PROFILE_STEP = 10; // m

/**
 * A course = polyline with cumulative distance, built from a route's waypoints. `pingpong` runs the route
 * forth and back (out-and-back, repeated as needed) until the target distance, `loop` repeats a closed route.
 * Elevation comes from a smoothed (±150 m) profile so grades behave like a barometric altimeter, not like the
 * raw 90 m surface model (which includes buildings in the city).
 */
export class Course {
  readonly lat: number[] = [];
  readonly lon: number[] = [];
  readonly cum: number[] = [];
  readonly length: number;
  private readonly profile: Float64Array;
  private k = 0;

  constructor(points: Waypoint[]) {
    let d = 0;
    const ele: number[] = [];
    points.forEach((p, i) => {
      if (i) d += haversine(points[i - 1]![0], points[i - 1]![1], p[0], p[1]);
      this.lat.push(p[0]);
      this.lon.push(p[1]);
      ele.push(p[2]);
      this.cum.push(d);
    });
    this.length = d;
    // resample elevation every 10 m, then smooth with a ±150 m moving average
    const n = Math.max(2, Math.ceil(d / PROFILE_STEP) + 1);
    const raw = new Float64Array(n);
    let j = 0;
    for (let k = 0; k < n; k++) {
      const s = Math.min(k * PROFILE_STEP, d);
      while (j < this.cum.length - 2 && this.cum[j + 1]! < s) j++;
      const seg = this.cum[j + 1]! - this.cum[j]!;
      const f = seg > 0 ? Math.min(1, Math.max(0, (s - this.cum[j]!) / seg)) : 0;
      raw[k] = ele[j]! + (ele[j + 1]! - ele[j]!) * f;
    }
    this.profile = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      let sum = 0;
      let cnt = 0;
      for (let q = Math.max(0, k - 15); q <= Math.min(n - 1, k + 15); q++) {
        sum += raw[q]!;
        cnt++;
      }
      this.profile[k] = sum / cnt;
    }
  }

  static build(route: Waypoint[], mode: 'pingpong' | 'loop', target: number): Course {
    const out: Waypoint[] = [];
    let total = 0;
    let forward = true;
    const push = (p: Waypoint) => {
      const last = out[out.length - 1];
      if (last) {
        if (last[0] === p[0] && last[1] === p[1]) return;
        total += haversine(last[0], last[1], p[0], p[1]);
      }
      out.push(p);
    };
    let guard = 0;
    while (total < target && guard++ < 200) {
      const seq = mode === 'loop' || forward ? route : [...route].reverse();
      for (const p of seq) {
        const last = out[out.length - 1];
        if (last && total + haversine(last[0], last[1], p[0], p[1]) >= target) {
          // cut exactly at the target distance
          const seg = haversine(last[0], last[1], p[0], p[1]);
          const f = seg > 0 ? (target - total) / seg : 0;
          push([
            last[0] + (p[0] - last[0]) * f,
            last[1] + (p[1] - last[1]) * f,
            last[2] + (p[2] - last[2]) * f,
          ]);
          total = target;
          break;
        }
        push(p);
      }
      forward = !forward;
    }
    return new Course(out);
  }

  /** Smoothed elevation at distance s. */
  eleAt(s: number): number {
    const x = Math.min(Math.max(s, 0), this.length) / PROFILE_STEP;
    const i = Math.min(Math.floor(x), this.profile.length - 2);
    const f = Math.min(1, x - i);
    return this.profile[i]! + (this.profile[i + 1]! - this.profile[i]!) * f;
  }

  /** Grade over ±30 m of the smoothed profile. */
  gradeAt(s: number): number {
    const a = Math.max(0, s - 30);
    const b = Math.min(this.length, s + 30);
    return b - a > 1 ? (this.eleAt(b) - this.eleAt(a)) / (b - a) : 0;
  }

  /** Position at distance s along the course (s should be non-decreasing between calls for speed). */
  at(s: number): { lat: number; lon: number; ele: number; bearing: number; grade: number } {
    const n = this.cum.length;
    if (s <= 0 || n < 2) {
      this.k = 0;
    } else {
      if (this.cum[this.k]! > s) this.k = 0;
      while (this.k < n - 2 && this.cum[this.k + 1]! < s) this.k++;
    }
    const i = Math.min(this.k, n - 2);
    const j = i + 1;
    const seg = this.cum[j]! - this.cum[i]!;
    const f = seg > 0 ? Math.min(1, Math.max(0, (s - this.cum[i]!) / seg)) : 0;
    return {
      lat: this.lat[i]! + (this.lat[j]! - this.lat[i]!) * f,
      lon: this.lon[i]! + (this.lon[j]! - this.lon[i]!) * f,
      ele: this.eleAt(s),
      bearing: bearing(this.lat[i]!, this.lon[i]!, this.lat[j]!, this.lon[j]!),
      grade: this.gradeAt(s),
    };
  }
}
