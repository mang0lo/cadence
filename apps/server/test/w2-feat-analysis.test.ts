import { describe, expect, it } from 'vitest';
import type { WorkoutStreams } from '@cadence/shared';
import { analyzeActivity, statsBetween, toSeries } from '../src/features/activities/analysis';
import { ANALYSIS_VERSION } from '../src/features/activities/store';
import { elevationGainLoss } from '../src/derive/metrics';

/**
 * Lap and segment climbing (statsBetween) uses the definition of the activity's elevation gain: elevation smoothed
 * within each part of the track, 2 m hysteresis, nothing between two parts.
 */

/** A hike with barometer noise (±0.8 m) in two parts: 1000 s up 50 m, a cable car ride (+500 m), 1000 s up 50 m. */
function noisyCableCar(): WorkoutStreams {
  const t: number[] = [];
  const dist: number[] = [];
  const ele: number[] = [];
  const moving: number[] = [];
  const noise = (i: number) => (i % 2 ? 0.8 : -0.8);
  for (let i = 0; i < 1000; i++) {
    t.push(i);
    dist.push(i);
    ele.push(1000 + 0.05 * i + noise(i));
    moving.push(i ? 1 : 0);
  }
  for (let i = 0; i < 1000; i++) {
    t.push(2800 + i);
    dist.push(999 + i);
    ele.push(1550 + 0.05 * i + noise(i));
    moving.push(i ? 1 : 0);
  }
  return { t, dist, ele, moving, speed: t.map(() => 1), breaks: [1000] };
}

describe('lap climbing like the activity elevation gain', () => {
  it('equals the elevation gain of the activity over the whole activity', () => {
    const streams = noisyCableCar();
    const s = toSeries(streams);
    const total = elevationGainLoss(Float64Array.from(streams.ele as number[]), 2, 5, streams.breaks).gain;
    expect(total).toBeGreaterThan(90);
    expect(total).toBeLessThan(101);
    expect(statsBetween(s, 0, 3800).elevGainM).toBeCloseTo(total, 6);
  });

  it('ignores barometer noise below the threshold and the height of the ride', () => {
    const s = toSeries(noisyCableCar());
    // raw samples with 1 m hysteresis counted every noise step (≈ 1.6 m per sample pair)
    const first = statsBetween(s, 0, 999).elevGainM!;
    expect(first).toBeGreaterThan(45);
    expect(first).toBeLessThan(51);
    // a lap across the ride climbs what both parts climb in it, not the 500 m of the ride
    const across = statsBetween(s, 500, 3300).elevGainM!;
    expect(across).toBeGreaterThan(45);
    expect(across).toBeLessThan(51);
  });

  it('splits the climbing of a part between its laps', () => {
    const s = toSeries(noisyCableCar());
    const whole = statsBetween(s, 0, 999).elevGainM!;
    const a = statsBetween(s, 0, 499).elevGainM!;
    const b = statsBetween(s, 500, 999).elevGainM!;
    // each lap restarts the hysteresis, so at most one threshold per lap is lost
    expect(a + b).toBeLessThanOrEqual(whole + 1e-9);
    expect(a + b).toBeGreaterThan(whole - 4);
  });

  it('laps of the analysis carry the new values (cached analyses are recomputed)', () => {
    const streams = noisyCableCar();
    const r = analyzeActivity({
      sport: 'hike',
      startTs: 0,
      endTs: 3800,
      lapLengthM: null,
      streams,
      events: [
        { type: 'lap', ts: 0, durationS: 1000, meta: null },
        { type: 'lap', ts: 2800, durationS: 1000, meta: null },
      ],
    });
    expect(r.laps).toHaveLength(2);
    for (const lap of r.laps) {
      expect(lap.elevGainM!).toBeGreaterThan(45);
      expect(lap.elevGainM!).toBeLessThan(51);
    }
    expect(ANALYSIS_VERSION).toBeGreaterThanOrEqual(3);
  });
});
