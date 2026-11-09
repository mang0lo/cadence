import { describe, expect, it } from 'vitest';
import { hardReps, trainingKind } from '@cadence/shared';
import { encodePolylineParts } from '../src/lib/geo';
import { countriesAlong, countrySearchCodes } from '../src/lib/places';

/** One sample per second: `pattern` is a list of [seconds, speed]. */
function stream(pattern: [number, number][]) {
  const t: number[] = [];
  const v: number[] = [];
  for (const [s, speed] of pattern) for (let i = 0; i < s; i++) (t.push(t.length), v.push(speed + Math.sin(t.length / 7) * 0.03));
  return { t, v };
}

describe('training kind', () => {
  it('counts hard repetitions in a pace stream', () => {
    const warm: [number, number] = [600, 2.8];
    const intervals = stream([warm, ...Array.from({ length: 6 }, () => [[120, 4.2], [90, 2.5]] as [number, number][]).flat(), [300, 2.7]]);
    expect(hardReps(intervals.t, intervals.v)).toBe(6);
    // a steady run, also one with a single faster finish
    expect(hardReps(...(Object.values(stream([[2400, 3.0]])) as [number[], number[]]))).toBe(0);
    expect(hardReps(...(Object.values(stream([[2000, 3.0], [300, 3.6]])) as [number[], number[]]))).toBe(1);
    // short surges are not repetitions
    const surges = stream([[600, 3], ...Array.from({ length: 8 }, () => [[15, 4.5], [120, 3]] as [number, number][]).flat()]);
    expect(hardReps(surges.t, surges.v)).toBe(0);
    expect(hardReps([0, 1, 2], [3, 3, 3])).toBe(0);
  });

  it('classifies by repetitions, length and heart-rate zones', () => {
    const base = { sport: 'run', movingS: 3000, distanceM: 9000, zones: [600, 1800, 400, 150, 50], hardReps: 0 };
    expect(trainingKind(base)).toBe('easy');
    expect(trainingKind({ ...base, hardReps: 5 })).toBe('intervals');
    expect(trainingKind({ ...base, movingS: 6000, distanceM: 19_000 })).toBe('long');
    expect(trainingKind({ ...base, zones: [200, 600, 900, 1000, 300] })).toBe('tempo');
    expect(trainingKind({ ...base, movingS: 1800, zones: [1600, 200, 0, 0, 0] })).toBe('recovery');
    // nothing to go on: no tag
    expect(trainingKind({ ...base, zones: null })).toBeNull();
    expect(trainingKind({ ...base, zones: [100, 100, 0, 0, 0] })).toBeNull(); // zones cover too little
    expect(trainingKind({ ...base, sport: 'walk' })).toBeNull();
    expect(trainingKind({ ...base, sport: 'strength' })).toBeNull();
    expect(trainingKind({ ...base, movingS: 300 })).toBeNull();
    expect(trainingKind({ ...base, sport: 'ride', movingS: 4 * 3600, zones: null })).toBe('long');
  });
});

describe('countries', () => {
  it('lists the countries along a route in order', () => {
    // Munich → Innsbruck → Bolzano
    const line = encodePolylineParts([
      [
        [48.137, 11.575],
        [47.269, 11.404],
        [46.498, 11.354],
      ],
    ]);
    expect(countriesAlong(line)).toEqual(['DE', 'AT', 'IT']);
    expect(countriesAlong(null)).toEqual([]);
  });

  it('finds country codes by English and German names', () => {
    expect(countrySearchCodes('italien')).toEqual(['IT']);
    expect(countrySearchCodes('Austria')).toEqual(['AT']);
    expect(countrySearchCodes('österreich')).toEqual(['AT']);
    expect(countrySearchCodes('de')).toEqual([]);
  });
});
