/** Power curve helpers (apps/web/src/features/progress/power.ts). */
import { describe, expect, it } from 'vitest';
import type { ProgressPowerCurve } from '@cadence/shared';
import { withBorrowedMass } from '@/features/progress/power';

const effort = (durationS: number, watts: number, wkg: number | null) => ({
  durationS,
  watts,
  wkg,
  workoutId: 1,
  name: 'Ride',
  sport: 'ride',
  startTs: 1_760_000_000,
  tzMin: 60,
  offsetS: 0,
});

const curve = (bodyMass: ProgressPowerCurve['bodyMass'], points: ProgressPowerCurve['points']): ProgressPowerCurve => ({
  fromDay: '2026-05-01',
  toDay: '2026-07-29',
  points,
  workouts: 12,
  bodyMass,
});

describe('withBorrowedMass', () => {
  it('gives a comparison without a body mass the W/kg of the period mass', () => {
    // weighing started after the comparison period: its W/kg were null and its line vanished from the W/kg chart
    const previous = curve(null, [effort(5, 812.4, null), effort(1200, 251, null)]);
    const out = withBorrowedMass(previous, { kg: 72.5, day: '2026-10-01' });
    expect(out.points.map((p) => p.wkg)).toEqual([11.21, 3.46]);
    expect(out.points.map((p) => p.watts)).toEqual([812.4, 251]);
    // the curve itself still has no mass of its own (the table shows no W/kg column for it)
    expect(out.bodyMass).toBeNull();
  });

  it('keeps a curve that has its own body mass, and one when there is nothing to borrow', () => {
    const own = curve({ kg: 70, day: '2026-07-01' }, [effort(5, 700, 10)]);
    expect(withBorrowedMass(own, { kg: 72.5, day: '2026-10-01' })).toBe(own);
    const none = curve(null, [effort(5, 700, null)]);
    expect(withBorrowedMass(none, null)).toBe(none);
  });
});
