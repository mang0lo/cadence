/**
 * Synthetic streams for the activity tests (pure functions of the activities feature: compare.ts, streams.ts).
 */
import type { WorkoutStreams } from '@cadence/shared';
import { prepareStreams, type Prepared } from '@/features/activities/lib/streams';

export const M_PER_DEG = 111_320;

/**
 * 1 Hz track heading east from (48.2, 16.37) at speed(t) m/s. `stops` are [from, to) seconds standing still (not
 * moving); `breakAt` starts a new track part at that sample, `jumpM` north of the previous fix (no distance counted).
 */
export function synth(
  seconds: number,
  o: {
    speed?: (t: number) => number;
    stops?: [number, number][];
    hr?: (t: number) => number;
    ele?: (d: number) => number;
    breakAt?: number;
    jumpM?: number;
    northM?: number;
    gps?: boolean;
  } = {},
): WorkoutStreams {
  const lat0 = 48.2 + (o.northM ?? 0) / M_PER_DEG;
  const lon0 = 16.37;
  const kx = M_PER_DEG * Math.cos((48.2 * Math.PI) / 180);
  const s: Required<Pick<WorkoutStreams, 't' | 'lat' | 'lon' | 'dist' | 'speed' | 'moving' | 'hr' | 'ele'>> =
    {
      t: [],
      lat: [],
      lon: [],
      dist: [],
      speed: [],
      moving: [],
      hr: [],
      ele: [],
    };
  let d = 0;
  let east = 0;
  let north = 0;
  for (let i = 0; i <= seconds; i++) {
    const stopped = (o.stops ?? []).some(([a, b]) => i > a && i <= b);
    const isBreak = i === o.breakAt;
    const v = stopped || isBreak ? 0 : (o.speed?.(i) ?? 3);
    if (i > 0 && !isBreak) {
      d += v;
      east += v;
    }
    if (isBreak) north += o.jumpM ?? 5000;
    s.t.push(i);
    s.lat.push(lat0 + north / M_PER_DEG);
    s.lon.push(lon0 + east / kx);
    s.dist.push(d);
    s.speed.push(v);
    s.moving.push(i === 0 || stopped || isBreak ? 0 : 1);
    s.hr.push(o.hr ? o.hr(i) : 140);
    s.ele.push(o.ele ? o.ele(d) : 200);
  }
  const out: WorkoutStreams = { ...s };
  if (o.gps === false) {
    delete out.lat;
    delete out.lon;
  }
  if (o.breakAt !== undefined) out.breaks = [o.breakAt];
  return out;
}

export const prep = (s: WorkoutStreams): Prepared => prepareStreams(s)!;
