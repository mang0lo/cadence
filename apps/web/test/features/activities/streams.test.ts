/**
 * Stream math of the activity page (apps/web/src/features/activities/lib/streams.ts): track breaks — a workout paused
 * in one place and continued elsewhere — are never interpolated across and are no climb.
 */
import { describe, expect, it } from 'vitest';
import type { WorkoutStreams } from '@cadence/shared';
import { positionAt, rangeStats, valueAtNoBreak } from '@/features/activities/lib/streams';
import { prep, synth } from './synth';

/** `s` with every elevation from sample `from` on raised by `m` (the new part starts higher up, e.g. a cable car). */
function lift(s: WorkoutStreams, from: number, m: number): WorkoutStreams {
  return { ...s, ele: s.ele!.map((e, i) => (i >= from && e !== null ? e + m : e)) };
}

describe('streams: positions on a track break', () => {
  it('stays at the last fix before the jump instead of placing the athlete on it', () => {
    const P = prep(synth(1000, { breakAt: 500, jumpM: 5000 }));
    expect(positionAt(P, 499.5)).toEqual([P.lon![499], P.lat![499]]);
    expect(positionAt(P, 500)).toEqual([P.lon![500], P.lat![500]]);
    // within a part it interpolates as before
    const mid = positionAt(P, 200.5)!;
    expect(mid[0]).toBeCloseTo((P.lon![200]! + P.lon![201]!) / 2, 12);
    expect(valueAtNoBreak(P.lat, 499.5, P.breaks)).toBe(P.lat![499]);
    expect(positionAt(prep(synth(100, { gps: false })), 10)).toBeNull();
  });
});

describe('streams: range statistics across a track break', () => {
  it('counts no climbing for the height difference between two parts', () => {
    // flat in both parts; the second part starts 700 m higher
    const P = prep(lift(synth(1000, { breakAt: 500, jumpM: 5000 }), 500, 700));
    const s = rangeStats(P, 0, 1000, 'hike');
    expect(s.gainM).toBe(0);
    expect(s.lossM).toBe(0);
    expect(s.avgGrade).toBeCloseTo(0, 12);
    expect(s.distanceM).toBeCloseTo(2997, 6); // 3 m/s; the jump adds no distance
  });

  it('counts no descent for a part that starts lower', () => {
    const P = prep(lift(synth(1000, { breakAt: 500, jumpM: 5000 }), 500, -300));
    const s = rangeStats(P, 100, 900, 'hike');
    expect(s.gainM).toBe(0);
    expect(s.lossM).toBe(0);
    expect(s.avgGrade).toBeCloseTo(0, 12);
  });

  it('still counts the climbs within each part', () => {
    // 5 % up in both parts (+0.15 m per second at 3 m/s); the second part starts 700 m higher
    const P = prep(lift(synth(1000, { breakAt: 500, jumpM: 5000, ele: (d) => 200 + 0.05 * d }), 500, 700));
    const s = rangeStats(P, 0, 1000, 'hike');
    // 499 s of climbing before the break and 500 s after it; the hysteresis loses less than 2 m per part
    expect(s.gainM!).toBeGreaterThan(0.15 * 999 - 4);
    expect(s.gainM!).toBeLessThanOrEqual(0.15 * 999 + 1e-9);
    expect(s.lossM).toBe(0);
    expect(s.avgGrade!).toBeCloseTo(0.05, 3);
    // a selection inside one part is unchanged
    const inner = rangeStats(P, 100, 400, 'hike');
    expect(inner.gainM!).toBeGreaterThan(0.15 * 300 - 2);
    expect(inner.gainM!).toBeLessThanOrEqual(0.15 * 300 + 1e-9);
    expect(inner.avgGrade!).toBeCloseTo(0.05, 6);
  });

  it('matches the plain computation without breaks', () => {
    const P = prep(synth(600, { ele: (d) => 200 + 10 * Math.sin(d / 200) }));
    const s = rangeStats(P, 0, 600, 'run');
    expect(s.gainM!).toBeGreaterThan(0);
    expect(s.lossM!).toBeGreaterThan(0);
    expect(s.avgGrade!).toBeCloseTo((P.ele![600]! - P.ele![0]!) / s.distanceM!, 12);
  });
});
