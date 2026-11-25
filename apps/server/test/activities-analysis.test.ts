import { describe, expect, it } from 'vitest';
import type { WorkoutStreams } from '@cadence/shared';
import { analyzeActivity, statsBetween, toSeries } from '../src/features/activities/analysis';

describe('climbs and laps across a track break', () => {
  /** Hike up 5 %, paused for a cable car (+500 m), then up 5 % again. */
  function cableCar(): WorkoutStreams {
    const t: number[] = [];
    const dist: number[] = [];
    const ele: number[] = [];
    const moving: number[] = [];
    const hr: number[] = [];
    for (let i = 0; i < 1000; i++) {
      t.push(i);
      dist.push(i);
      ele.push(1000 + 0.05 * i);
      moving.push(i ? 1 : 0);
      hr.push(130);
    }
    for (let i = 0; i < 1000; i++) {
      t.push(2800 + i);
      dist.push(999 + i);
      ele.push(1550 + 0.05 * i);
      moving.push(i ? 1 : 0);
      hr.push(130);
    }
    return { t, dist, ele, moving, hr, speed: t.map(() => 1), breaks: [1000] };
  }

  it('detects one climb per part with the real elevations and without the ride in its time', () => {
    const a = analyzeActivity({ sport: 'hike', startTs: 0, endTs: 3800, lapLengthM: null, streams: cableCar(), events: [] });
    expect(a.climbs).toHaveLength(2);
    const [c1, c2] = a.climbs as [(typeof a.climbs)[0], (typeof a.climbs)[0]];
    for (const c of [c1, c2]) {
      expect(c.gainM).toBeGreaterThan(40);
      expect(c.gainM).toBeLessThan(51);
      expect(c.durationS).toBeLessThan(1000);
      expect(c.vam).toBeGreaterThan(160);
    }
    expect(c1.startEleM).toBeLessThan(1010);
    expect(c1.endEleM).toBeLessThan(1051);
    expect(c2.startEleM).toBeGreaterThan(1545);
    expect(c2.endEleM).toBeGreaterThan(1590);
    expect(c2.startT).toBeGreaterThanOrEqual(2800);
  });

  it('does not count the height of the ride as lap climbing', () => {
    const s = toSeries(cableCar());
    const st = statsBetween(s, 0, 3800);
    expect(st.elevGainM!).toBeGreaterThan(95);
    expect(st.elevGainM!).toBeLessThan(101);
    expect(st.movingS).toBeCloseTo(1998, 6);
  });
});
