import { describe, expect, it } from 'vitest';
import { BEST_EFFORTS, SPORTS, effortDefinitions, isSport, sportFromActivityType, sportInfo } from '../src';

/** Keys every plain object inherits: user input like ?sport=toString must never reach them. */
const PROTO_KEYS = ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'];

describe('sport lookups by user input', () => {
  it('resolve keys of the object prototype to the "other" sport', () => {
    for (const key of PROTO_KEYS) {
      expect(sportInfo(key), key).toBe(SPORTS.other);
      expect(isSport(key), key).toBe(false);
    }
    expect(sportInfo('run').key).toBe('run');
    expect(sportInfo('no-such-sport')).toBe(SPORTS.other);
    expect(isSport('run')).toBe(true);
    expect(isSport('other')).toBe(true);
    expect(isSport('')).toBe(false);
  });

  it('map activity types of a crafted export to "other", not to a function', () => {
    for (const key of PROTO_KEYS) expect(sportFromActivityType(`HKWorkoutActivityType${key}`), key).toBe('other');
    expect(sportFromActivityType('HKWorkoutActivityTypeRunning')).toBe('run');
    expect(sportFromActivityType('Running')).toBe('run');
    expect(sportFromActivityType('HKWorkoutActivityTypeSomethingNew')).toBe('other');
  });

  it('give best effort distances only for sports that have them', () => {
    expect(effortDefinitions('run')).toBe(BEST_EFFORTS.run);
    expect(effortDefinitions('yoga')).toEqual([]);
    for (const key of PROTO_KEYS) expect(effortDefinitions(key), key).toEqual([]);
  });
});
